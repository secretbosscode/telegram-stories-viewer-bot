# Dockerfile for Telegram Bot with Stripe & SQLite support

# Use official Node.js runtime as base
FROM node:18

# Create app directory
WORKDIR /app

# Copy package.json and yarn.lock
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install

# Copy the rest of the application
COPY . .

# Install SQLite CLI (optional, mostly for debugging)
RUN apt-get update && \
    apt-get install -y sqlite3 && \
    rm -rf /var/lib/apt/lists/*

# Build the app (TypeScript -> JavaScript)
RUN yarn build

# Set environment variables (can be overridden in compose or CLI)
ENV NODE_ENV=production

# Expose the webhook port
EXPOSE 33444

# Start the Express server that includes the Stripe webhook and bot
CMD ["node", "dist/server.js"]
