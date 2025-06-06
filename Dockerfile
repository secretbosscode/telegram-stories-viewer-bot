# =========================================================================
# Stage 1: The "Builder" - Compile a secure `su-exec` binary
# =========================================================================
# Use the lightweight Alpine image, which has the tools we need
FROM alpine:latest as builder

# Install git and the C compiler toolchain (build-base)
RUN apk add --no-cache git build-base

# Clone the su-exec repository
RUN git clone https://github.com/ncopa/su-exec.git /su-exec

# BUG FIX: Use 'make install' to compile and place the binary in a standard path
# The 'make' command on its own only compiles; 'make install' puts it in /usr/local/bin
RUN cd /su-exec && make install

# =========================================================================
# Stage 2: The "Final Image" - Our Node.js Application
# =========================================================================
# Use the official Node.js LTS slim runtime as our secure and reliable base
FROM node:22-slim

# Copy the su-exec binary we just built AND installed in the previous stage.
# It is now in a standard, predictable location.
COPY --from=builder /usr/local/bin/su-exec /usr/local/bin/su-exec

# Install only the remaining system dependencies
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
