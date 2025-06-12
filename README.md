# Telegram Stories Viewer Bot

This project packages a Telegram bot for anonymously viewing stories. It is based on the original work by **Kamol Khamidov** but most of the codebase has been rewritten to run completely inside a Docker container.

## Quick start

1. Copy `.env.example` to `.env` and fill out the required values (see the
   *Environment variables* section below for details):
   - `DEV_BOT_TOKEN` or `PROD_BOT_TOKEN` – your bot token from [BotFather](https://t.me/BotFather)
   - `USERBOT_API_ID` and `USERBOT_API_HASH` – obtain these from [my.telegram.org](https://my.telegram.org)
   - `USERBOT_PHONE_NUMBER` – the phone number of the account that will act as the userbot
   - Optionally `USERBOT_PASSWORD` if that account has two‑factor authentication enabled
   - Leave `USERBOT_PHONE_CODE` empty on the first run
   - Fill in `BOT_ADMIN_ID` and either `BTC_WALLET_ADDRESS` or one of `BTC_XPUB`, `BTC_YPUB`, `BTC_ZPUB`
   - Optional: `LOG_FILE` to change where runtime errors are stored. Set `DEBUG_LOG=true` to also mirror all console output to `/data/debug.log`.

2. Build and start the container:

```bash
docker compose up
```

The container stores its runtime files in `/data`. Map a persistent directory on
the host to this path (for example `~/bot-data:/data`). Because the application
always writes to `/data`, no `DATA_DIR` environment variable is required.

The compose file sets `stdin_open: true` and `tty: true` so you can enter the SMS code in the terminal on the first run. When the container prints `USERBOT_PHONE_CODE is required for first login!`, type the code you receive from Telegram. After the session is saved to `/data/userbot-session`, future starts do not require a code and you can run in detached mode with `docker compose up -d`.

Logs are available with `docker logs ghost-stories-bot` and additionally stored in the file pointed to by `LOG_FILE`. When `DEBUG_LOG` is enabled, all console output is mirrored to `/data/debug.log` for troubleshooting.

## Environment variables

The bot is configured through environment variables. Copy `.env.example` to `.env` and provide the following values:

| Name | Required | Description |
| ---- | -------- | ----------- |
| `DEV_BOT_TOKEN` | when `NODE_ENV=development` | Bot token from BotFather used in development mode. |
| `PROD_BOT_TOKEN` | when `NODE_ENV=production` | Bot token from BotFather used in production. |
| `USERBOT_API_ID` | yes | API ID from [my.telegram.org](https://my.telegram.org). |
| `USERBOT_API_HASH` | yes | API hash from [my.telegram.org](https://my.telegram.org). |
| `USERBOT_PHONE_NUMBER` | yes | Phone number of the userbot account. |
| `USERBOT_PASSWORD` | optional | Two‑factor authentication password for that account. |
| `USERBOT_PHONE_CODE` | only on first run | SMS code for the initial login. Leave empty afterwards. |
| `BOT_ADMIN_ID` | yes | Telegram ID of the bot administrator. |
| `BTC_WALLET_ADDRESS` | required* | Fixed Bitcoin address used for payments if no extended key is provided. |
| `BTC_XPUB` | optional* | Extended public key for deriving unique payment addresses. |
| `BTC_YPUB` | optional* | Same as above but using the YPUB format. |
| `BTC_ZPUB` | optional* | Same as above but using the ZPUB format. |
| `LOG_FILE` | optional | Path for runtime error logs (default `/data/error.log`). |
| `DEBUG_LOG` | optional | Set to `true` or `1` to mirror all console output to `/data/debug.log`. |

`*` At least one of `BTC_WALLET_ADDRESS`, `BTC_XPUB`, `BTC_YPUB` or `BTC_ZPUB` must be set.

### BTC payments

When a user runs `/upgrade` the bot creates an invoice for roughly five dollars worth of BTC. If `BTC_WALLET_ADDRESS` is set, all invoices point to that address. When an extended public key is provided instead (`BTC_XPUB`, `BTC_YPUB` or `BTC_ZPUB`), a new address is derived for each invoice using the BIP32 path `m/0/<index>`. After sending the payment the user confirms it with `/verify <txid>` and Premium access is granted once the transaction is detected.

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
npm install --legacy-peer-deps
npm test
```

---

This fork is a heavy rewrite of the original project and aims to provide a simple container-based deployment. See the [LICENSE](LICENSE) for copyright details.
