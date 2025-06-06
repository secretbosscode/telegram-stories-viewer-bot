# Use the official Node.js runtime as a secure and reliable base
FROM node:22

# =========================================================================
# STEP 1: Install system dependencies as ROOT
# =========================================================================
# Install essential tools:
#   - sqlite3: For the application's database CLI.
#   - gosu: A lightweight and secure tool for dropping root privileges.
RUN apt-get update && \
    apt-get install -y sqlite3 gosu && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# =========================================================================
# STEP 2: Create a generic, non-root user and group
# =========================================================================
# COMMENT: This creates a placeholder user. The entrypoint script will
# modify its User ID (UID) and Group ID (GID) at runtime to match your
# host user, which solves volume permission issues.
RUN addgroup --system --gid 1001 appgroup
RUN adduser --system --uid 1001 --ingroup appgroup --shell /bin/sh appuser

# =========================================================================
# STEP 3: Copy and build the application
# =========================================================================
# Copy package files first to leverage Docker's build cache
COPY package.json yarn.lock ./

# Install project dependencies
RUN yarn install

# Copy all application source code into the container
COPY . .

# Build the TypeScript code into JavaScript in the 'dist' directory
RUN yarn build

# =========================================================================
# STEP 4: Set up environment and permissions
# =========================================================================

# COMMENT: This line is from your original Dockerfile. It's a best practice
# that tells Node.js and other libraries to use optimized production settings.
ENV NODE_ENV=production

# COMMENT: This line is from your original Dockerfile. It is CRITICAL for
# your Stripe webhook. It opens the port so Docker can map it to your host.
EXPOSE 33444

# Copy our new entrypoint script into a standard location in the container
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# Make the entrypoint script executable
RUN chmod +x /usr/local/bin/entrypoint.sh

# COMMENT: The `chown` command is no longer needed here. It will be
# handled more flexibly inside the entrypoint.sh script at runtime.

# Set our script as the entrypoint for the container
ENTRYPOINT ["entrypoint.sh"]

# =========================================================================
# STEP 5: Define the default command
# =========================================================================
# This is the command that gets passed to the entrypoint script.
# The entrypoint script will execute this command as the non-root 'appuser'.
CMD ["node", "dist/index.js"]
