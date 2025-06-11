module.exports = {
  apps: [
    {
      name: 'telegram-stories-bot',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1000M',
    },
  ],
};

// command to run pm2:
// npx pm2 start ecosystem.config.js
