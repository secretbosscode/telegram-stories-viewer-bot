# Use Node 18 (compatible with eslint-plugin-effector)
FROM node:18-slim

# Create app working directory
WORKDIR /app

# Copy dependency files first
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install

# Copy the rest of the application code
COPY . .

# Build the TypeScript source to JS
RUN yarn build

# Set environment variable for production mode
ENV NODE_ENV=production

# Start the bot (entry point is dist/main.js after build)
CMD ["node", "dist/main.js"]
