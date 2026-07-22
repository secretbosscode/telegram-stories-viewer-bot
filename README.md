# Telegram Stories Viewer Bot

This project packages a Telegram bot for anonymously viewing stories. It is based on the original work by **Kamol Khamidov**, but most of the codebase has been rewritten to run completely inside a Docker container.

## Quick start

1. Copy `.env.example` to `.env` and fill out the existing required values:
   - `DEV_BOT_TOKEN` or `PROD_BOT_TOKEN` – your bot token from BotFather
   - `USERBOT_API_ID` and `USERBOT_API_HASH` – obtain these from my.telegram.org
   - `USERBOT_PHONE_NUMBER` – the phone number of the account that acts as the userbot
   - Optionally `USERBOT_PASSWORD` if that account has two-factor authentication enabled
   - Leave `USERBOT_PHONE_CODE` empty on the first run
   - Set `BOT_ADMIN_ID` to the Telegram ID of the bot administrator
   - Optional: `LOG_FILE` to change where runtime errors are stored. Set `DEBUG_LOG=true` to mirror console output to `/data/debug.log`.

2. Build and start the container:

```bash
docker compose up
```

The container stores runtime files in `/data`. Map a persistent host directory to this path. Because the application always writes to `/data`, no `DATA_DIR` environment variable is required.

The compose file sets `stdin_open: true` and `tty: true` so the first userbot login code can be entered in the terminal. After the session is saved to `/data/userbot-session`, future starts do not require a code and the service can run with `docker compose up -d`.

Logs are available with `docker logs ghost-stories-bot` and in the file selected by `LOG_FILE`. When `DEBUG_LOG` is enabled, console output is also mirrored to `/data/debug.log`.

## Telegram Stars payments

The normal production mode uses Telegram Stars to sell verified result bundles:

1. A user searches for a profile or story as usual.
2. The bot checks for results for free.
3. When no results exist, the user is told that nothing was found and no invoice is created.
4. When results exist, the bot shows the result count and offers a native Telegram Stars invoice.
5. After Telegram confirms payment, the bot automatically delivers the exact story IDs included in the offer.
6. Delivery retries survive restarts. If the purchased bundle becomes impossible to deliver, the bot automatically issues a full Stars refund.

Stars do not require a payment-provider token, merchant environment variables, or a separate wallet configuration. The existing Telegram bot token is used.

### Administration

Use the admin-only command:

```text
/starsadmin
```

The panel shows:

- whether Stars purchases are enabled
- the current result-unlock price
- purchases and Stars earned
- pending deliveries
- failed or refund-pending deliveries
- completed refunds

The price can be changed immediately with the panel buttons or:

```text
/setstarsprice 25
```

New offers use the new price. Existing offers retain the price shown when they were created. No container restart or `.env` edit is required.

Routine payment support is handled privately inside the bot through `/paysupport`. The command checks delivery status, requeues pending delivery, and reports completed refunds without exposing the operator's identity.

### Automatic upgrade behavior

The database migration is additive and runs automatically at startup. Existing users, Premium expiration dates, monitoring configuration, queue data, and BTC payment history are preserved.

Installations with no completed BTC payments start in Telegram Stars mode automatically. Active Premium users and the administrator continue to bypass result payments. Existing Premium or trial expiration dates are honored, but new free trials are not issued in Stars mode.

No new environment variables are required to upgrade an existing installation.

## Legacy BTC mode

The existing BTC Premium implementation remains available as a rollback path when a fixed wallet or extended public key is configured. BTC variables are optional and are no longer required for the bot to start.

In Stars mode:

- no BTC invoices are generated
- BTC polling is disabled
- `/verify` is removed from the customer command menu
- free-trial and BTC payment references are removed from help and customer messaging

An administrator with an existing BTC configuration can select the legacy provider from `/starsadmin`. This is intended as an operational fallback; Telegram Stars is the normal in-bot payment method for digital results.

## Environment variables

| Name | Required | Description |
| ---- | -------- | ----------- |
| `DEV_BOT_TOKEN` | when `NODE_ENV=development` | Bot token used in development mode. |
| `PROD_BOT_TOKEN` | when not in development | Bot token used in production and test mode. |
| `USERBOT_API_ID` | yes | API ID from my.telegram.org. |
| `USERBOT_API_HASH` | yes | API hash from my.telegram.org. |
| `USERBOT_PHONE_NUMBER` | yes | Phone number of the userbot account. |
| `USERBOT_PASSWORD` | optional | Two-factor authentication password for the userbot account. |
| `USERBOT_PHONE_CODE` | first login only | Login code for the initial userbot session. |
| `BOT_ADMIN_ID` | yes | Telegram ID of the bot administrator. |
| `BTC_WALLET_ADDRESS` | optional legacy | Fixed address for legacy BTC Premium mode. |
| `BTC_XPUB` | optional legacy | Extended public key for legacy BTC mode. |
| `BTC_YPUB` | optional legacy | Extended public key in YPUB format. |
| `BTC_ZPUB` | optional legacy | Extended public key in ZPUB format. |
| `LOG_FILE` | optional | Runtime error log path; defaults to `/data/error.log`. |
| `DEBUG_LOG` | optional | Set to `true` or `1` to mirror console output to `/data/debug.log`. |
| `DISABLE_STEALTH_MODE` | optional | Set to `true` or `1` to skip activating Telegram stealth mode. |

Stars prices, payment enablement, bundle lifetime, delivery state, and statistics are stored in SQLite and managed by the bot. They are intentionally not environment variables.

## Usage

Send the bot a username, phone number, or direct story link. The bot checks for available stories and, in Stars mode, offers the verified result bundle for purchase only when results exist.

Active Premium users and administrators retain the existing bypass behavior. Premium users can retrieve archived stories with `/archive <@username>` and monitor up to five profiles using `/monitor` and `/unmonitor`. Administrators can also fetch the global stories feed with `/globalstories`.

## Development

The application is written in TypeScript. Install Node.js and run:

```bash
npm install -g npm@11.4.1
npm install --legacy-peer-deps
npm run build
npm test
```

---

This fork is a heavy rewrite of the original project and aims to provide a simple container-based deployment. See the [LICENSE](LICENSE) for copyright details.
