# =========================================================================
# Stage 1: The "Builder" - Compile a secure `su-exec` binary
# =========================================================================
# Use a minimal Alpine image with build tools to compile our C-based utility.
FROM alpine:latest as builder

# Install git and the C compiler toolchain (build-base)
RUN apk add --no-cache git build-base

# Clone the su-exec repository and build it.
RUN git clone https://github.com/ncopa/su-exec.git /su-exec \
    && cd /su-exec \
    && make

# =========================================================================
# Stage 2: The "Final Image" - Our Node.js Application
# =========================================================================
# Use the official Node.js LTS slim runtime as our secure and reliable base
FROM node:22-slim

# Copy the su-exec binary we just built in the previous stage.
COPY --from=builder /su-exec/su-exec /usr/local/bin/su-exec

# Install the remaining system dependencies (sqlite3 only)
RUN apt-get update && \
    apt-get install -y sqlite3 && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
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
EXPOSE 33444

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Set our script as the entrypoint for the container
ENTRYPOINT ["entrypoint.sh"]

# =========================================================================
# Define the default command
# =========================================================================
CMD ["node", "dist/index.js"]
