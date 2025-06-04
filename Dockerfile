# Use Node 20 with Yarn preinstalled
FROM node:20-slim

# Create app directory
WORKDIR /app

# Copy dependency files first
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install

# Copy the rest of the code
COPY . .

# Build TypeScript
RUN yarn build

# Set NODE_ENV just in case
ENV NODE_ENV=production

# Start the bot
CMD ["node", "dist/main.js"]
