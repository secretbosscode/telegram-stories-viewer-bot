# Use official Node.js 18 base image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package manifests first to optimize Docker layer caching
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install

# Copy the rest of the application source
COPY . .

# Build TypeScript sources
RUN yarn build

# Run the compiled entry point
CMD ["node", "dist/index.js"]
