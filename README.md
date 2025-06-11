# Telegram Stories Viewer Bot

This project packages a Telegram bot for anonymously viewing stories. It is based on the original work by **Kamol Khamidov** but most of the codebase has been rewritten to run completely inside a Docker container.

## Quick start

1. Copy `.env.example` to `.env` and fill out the required values:
   - `DEV_BOT_TOKEN` or `PROD_BOT_TOKEN` – your bot token from [BotFather](https://t.me/BotFather)
   - `USERBOT_API_ID` and `USERBOT_API_HASH` – obtain these from [my.telegram.org](https://my.telegram.org)
   - `USERBOT_PHONE_NUMBER` – the phone number of the account that will act as the userbot
   - Optionally `USERBOT_PASSWORD` if that account has two‑factor authentication enabled
   - Leave `USERBOT_PHONE_CODE` empty on the first run
   - Fill in `BOT_ADMIN_ID` and either `BTC_WALLET_ADDRESS` or one of `BTC_XPUB`, `BTC_YPUB`, `BTC_ZPUB`
  - Optional: `LOG_FILE` to change where runtime errors are stored. Set `DEBUG_LOG=true` to also mirror all console output to `./data/debug.log`.

2. Build and start the container:

```bash
docker compose up
```

The compose file sets `stdin_open: true` and `tty: true` so you can enter the SMS code in the terminal on the first run. When the container prints `USERBOT_PHONE_CODE is required for first login!`, type the code you receive from Telegram. After the session is saved to `storage_entry/userbot-session`, future starts do not require a code and you can run in detached mode with `docker compose up -d`.

Logs are available with `docker logs ghost-stories-bot` and additionally stored in the file pointed to by `LOG_FILE`. When `DEBUG_LOG` is enabled, all console output is mirrored to `./data/debug.log` for troubleshooting.

## Usage

Send the bot a username, phone number or link to a story. The bot will fetch the available stories and return them to you. Premium users can monitor up to five profiles with `/monitor <@username|+15555555555>` and `/unmonitor <@username>`.
Administrators browse stories with the same paginated interface to prevent large downloads from clogging the queue.

After paying for Premium you can verify the transaction manually with:

```
/verify <txid>
```

## Development

The application is written in TypeScript. If you wish to run tests or build locally, install Node.js and run:

```bash
yarn install
yarn test
```

---

This fork is a heavy rewrite of the original project and aims to provide a simple container-based deployment. See the [LICENSE](LICENSE) for copyright details.
