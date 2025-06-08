# =========================================================================
# Stage 1: The "Builder" - Compile a secure `gosu` binary from source
# =========================================================================
# Use the official Go image based on Debian Bookworm to perfectly match our final image's OS.
FROM golang:1.24-bookworm as builder

# Install git, which is needed to clone the gosu source code.
RUN apt-get update && apt-get install -y --no-install-recommends git

# Set the version of gosu we want to build. 1.17 is the latest stable version.
ENV GOSU_VERSION 1.17

# Clone the gosu repository, check out the specific version tag...
RUN git clone https://github.com/tianon/gosu.git /gosu
RUN cd /gosu && git checkout "$GOSU_VERSION"

# ...and build it as a static binary, which is self-contained.
# CGO_ENABLED=0 ensures no C libraries are linked.
# -ldflags "-s -w" strips debug symbols, making the binary smaller.
RUN cd /gosu && CGO_ENABLED=0 go build -v -ldflags="-s -w" -o /usr/local/bin/gosu .

# =========================================================================
# Stage 2: The "Final Image" - Our Node.js Application
# =========================================================================
# Use the official Node.js LTS slim runtime as our secure and reliable base.
FROM node:22-slim

# Copy the freshly compiled gosu binary from our builder stage.
COPY --from=builder /usr/local/bin/gosu /usr/local/bin/gosu

# Install only the remaining system dependencies.
RUN apt-get update && \
    apt-get install -y sqlite3 && \
    rm -rf /var/lib/apt/lists/*

#RUN apk add --no-cache sqlite sqlite-dev python3 make g++

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
COPY package.json yarn.lock ./
RUN yarn install
COPY . .
RUN yarn build

# =========================================================================
# Set up environment and permissions
# =========================================================================
ENV NODE_ENV=production

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Set our script as the entrypoint for the container.
ENTRYPOINT ["entrypoint.sh"]

# =========================================================================
# Define the default command
# =========================================================================
CMD ["node", "dist/index.js"]
