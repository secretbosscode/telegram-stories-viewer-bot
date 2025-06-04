FROM node:18

WORKDIR /app

# Install only production dependencies
COPY package*.json yarn.lock ./
RUN yarn install --production

# Copy rest of the app and build
COPY . .
RUN yarn build

# Hardcode production environment
ENV NODE_ENV=production

# Run the bot
CMD ["node", "dist/index.js"]
