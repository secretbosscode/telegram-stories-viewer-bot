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

# Ensure SQLite is available
RUN apt-get update && \
    apt-get install -y sqlite3 && \
    rm -rf /var/lib/apt/lists/*

# Build the app if using TypeScript
RUN yarn build

# Set environment variables (override in docker-compose or CLI)
ENV NODE_ENV=production

# Start the application
CMD ["node", "dist/index.js"]
