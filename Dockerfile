# =========================================================================
# Stage 1: The "Builder" - Compile a secure `gosu` binary from source
# =========================================================================
# Use the official Go image based on Debian Bookworm to perfectly match our final image's OS.
FROM golang:1.24-alpine AS builder

# Install git, which is needed to clone the gosu source code.
RUN apk add --no-cache git

# Set the version of gosu we want to build. 1.17 is the latest stable version.
ENV GOSU_VERSION=1.17

# Clone the gosu repository, check out the specific version tag...
RUN git clone https://github.com/tianon/gosu.git /gosu
RUN cd /gosu && git checkout "$GOSU_VERSION"

# ...and build it as a static binary, which is self-contained.
# CGO_ENABLED=0 ensures no C libraries are linked.
# -ldflags "-s -w" strips debug symbols, making the binary smaller.
RUN cd /gosu && CGO_ENABLED=0 go build -v -ldflags="-s -w" -o /usr/local/bin/gosu .

# =========================================================================
# Stage 2: Dependency manifest with the release version normalised
# =========================================================================
# auto-release.yml bumps "version" in package.json and package-lock.json on
# every push to main. Copying those files straight into the image would change
# the `npm ci` layer's cache key on every release even when no dependency
# changed, so every publish reinstalled node_modules and pushed a new copy of
# it. Only the root version is rewritten here; dependency data is untouched,
# and the real files are copied over these by `COPY . .` further down, so the
# shipped package.json still carries the released version.
FROM node:22-alpine AS manifest
WORKDIR /src
COPY package.json package-lock.json ./
RUN node -e ' \
  const fs = require("fs"); \
  for (const f of ["package.json", "package-lock.json"]) { \
    const j = JSON.parse(fs.readFileSync(f, "utf8")); \
    j.version = "0.0.0"; \
    if (j.packages && j.packages[""]) j.packages[""].version = "0.0.0"; \
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n"); \
  }'

# =========================================================================
# Stage 3: The application image
# =========================================================================
# Use the official Node.js LTS alpine runtime as our secure and reliable base.
FROM node:22-alpine AS app

# Copy the freshly compiled gosu binary from our builder stage.
COPY --from=builder /usr/local/bin/gosu /usr/local/bin/gosu

# Install only the remaining system dependencies.
RUN apk add --no-cache sqlite sqlite-dev python3 make g++ shadow

# Ensure the latest npm is installed to avoid upgrade notices
RUN npm install -g npm@11.4.1

# Set the working directory inside the container.
WORKDIR /app

# =========================================================================
# Create a generic, non-root user and group
# =========================================================================
RUN addgroup --system --gid 1001 appgroup
RUN adduser --system --uid 1001 --ingroup appgroup --shell /bin/sh appuser

# =========================================================================
# Copy and build the application
# =========================================================================
# Everything under /app is created as appuser:appgroup directly. This gives the
# same ownership the old trailing `chown -R appuser:appgroup /app` produced,
# without that step re-writing all of node_modules into an extra layer on
# every build (which was also re-pushed to the registry every time). gosu is
# used instead of `USER appuser` so the image config keeps no USER at all.
RUN chown appuser:appgroup /app
COPY --from=manifest --chown=appuser:appgroup /src/package.json /src/package-lock.json ./
RUN gosu appuser npm ci --legacy-peer-deps
COPY --chown=appuser:appgroup . .
RUN gosu appuser npm run build

# =========================================================================
# Set up environment and permissions
# =========================================================================
# Modes are set explicitly so the image never depends on the file mode the
# checkout happened to produce (entrypoint.sh is 0644 in git).
COPY entrypoint.sh healthcheck.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

# Do NOT set `USER appuser` here. The container must start as root so that
# entrypoint.sh can apply the PUID/PGID mapping and chown /data before dropping
# privileges to appuser via gosu. Setting USER here would skip every
# `id -u = 0` branch in entrypoint.sh, leaving /data potentially unwritable.

# Set our script as the entrypoint for the container.
ENTRYPOINT ["entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["/usr/local/bin/healthcheck.sh"]

# =========================================================================
# Define the default command
# =========================================================================
CMD ["node", "dist/index.js"]

# =========================================================================
# Stage 4: Pre-publish verification (CI only: `--target verify`)
# =========================================================================
# Not part of the default build. docker-publish.yml builds this target before
# pushing: the Jest suite runs against the exact node_modules and dist that
# ship, and the real entrypoint is exercised under the deployment UID/GID.
# Everything here happens inside the BuildKit sandbox, so the tests' writes to
# /data never touch the runner or the TrueNAS host.
FROM app AS verify
ENV NODE_ENV=test \
    PROD_BOT_TOKEN=test-token \
    DEV_BOT_TOKEN=test-token \
    USERBOT_API_ID=1 \
    USERBOT_API_HASH=test-hash \
    USERBOT_PHONE_NUMBER=+15555550100 \
    USERBOT_PASSWORD= \
    USERBOT_PHONE_CODE= \
    BOT_ADMIN_ID=999
RUN mkdir -p /data && chown appuser:appgroup /data
RUN gosu appuser timeout 360s npm test -- --runInBand --forceExit
RUN set -eu; \
    for f in entrypoint.sh healthcheck.sh; do \
      mode=$(stat -c '%a %u:%g' "/usr/local/bin/$f"); \
      echo "$f: $mode"; \
      [ "$mode" = "755 0:0" ] || { echo "$f must be 0755 root:root" >&2; exit 1; }; \
    done; \
    rm -rf /data && mkdir /data; \
    PUID=568 PGID=568 /usr/local/bin/entrypoint.sh sh -c ' \
      set -eu; \
      [ "$(id -u):$(id -g)" = "568:568" ] || { echo "running as $(id -u):$(id -g), expected 568:568" >&2; exit 1; }; \
      touch /data/.write-probe && rm /data/.write-probe; \
      test -r /app/dist/index.js; \
      cd /app && node -e "new (require(\"better-sqlite3\"))(\":memory:\").prepare(\"select 1\").get()"; \
      echo "entrypoint OK: app user $(id -u):$(id -g) can write /data and load native modules"'

# =========================================================================
# Default target: the application image (keep this stage last)
# =========================================================================
FROM app
