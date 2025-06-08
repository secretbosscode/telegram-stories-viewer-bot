<h1><a href="https://t.me/tg_stories_downloader_bot">🕵🏼‍♂️ Telegram Stories Viewer Bot</a></h1>

<p>The bot allows to view Telegram stories <code>anonymously</code> by leveraging a bot and userbot</p>

<h2>📊 Bot usage statistics (as of January 28, 2025)</h2>

<table>
    <thead>
        <tr>
            <th>Metric</th>
            <th>Value</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td><b>🟢 Active users count</b></td>
            <td><details><summary><b>12,335</b></summary><img src="https://github.com/user-attachments/assets/d72b2af9-b3b7-47b6-883f-49402aa7d167" /></details></td>
        </tr>
        <tr>
            <td><b>👤 Total users count</b></td>
            <td><details><summary><b>33,425</b></summary><img src="https://github.com/user-attachments/assets/bccd8b8d-b190-47e0-af33-3283f3cd9c56" /></details></td>
        </tr>
        <tr>
            <td><b>🔄 Requests per day</b></td>
            <td><details><summary><b>~4,530</b></summary><img src="https://github.com/user-attachments/assets/b135791f-3b11-4f36-a268-2214090cfd8c" /></details></td>
        </tr>
    </tbody>
</table>

<h2>📸 Screenshots</h2>

<table>
  <tr>
    <td><img src="assets/happy-path.png" alt="downloading happy path"></td>
    <td><img src="assets/progress-info.png" alt="downloading progress info"></td>
	</tr>
  <tr>
    <td><img src="assets/direct-link.png" alt="downloading via direct link"></td>
    <td><img src="assets/error.png" alt="wrong command use cases"></td>
  </tr>
</table>

<h2>⚙️ How it works?</h2>

<details>

  <summary>Initiate the userbot:</summary>
  <br/>

```typescript
import { TelegramClient } from 'telegram';
import { StoreSession } from 'telegram/sessions';

async function main() {
  const client = await initClient();
}

async function initClient() {
  const storeSession = new StoreSession('userbot-session');

  const client = new TelegramClient(
    storeSession,
    USERBOT_API_ID,
    USERBOT_API_HASH,
    {
      connectionRetries: 5,
    },
  );

  await client.start({
    phoneNumber: USERBOT_PHONE_NUMBER,
    password: async () => await input.text('Please enter your password: '),
    phoneCode: async () =>
      await input.text('Please enter the code you received: '),
    onError: (err) => console.log('error: ', err),
  });
  console.log('You should now be connected.');
  console.log(client.session.save()); // Save the session to avoid logging in again
  await client.sendMessage('me', { message: 'Hi!' });

  return client;
}
```

</details>

• Get user's entities by username:

```typescript
const username = '@chupapee';
const entity = await client.getEntity(username);
```

• Get stories data by entity:

```typescript
import { Api } from 'telegram';

const activeStories = await client.invoke(
  new Api.stories.GetPeerStories({ peer: entity }),
);

const pinnedStories = await client.invoke(
  new Api.stories.GetPinnedStories({ peer: entity }),
);
```

• Download stories using `media` prop of story object:

```typescript
const stories = await downloadStories(activeStories, pinnedStories);

async function downloadStories(activeStories, pinnedStories) {
  const result = [];

  for (const story of [...activeStories, ...pinnedStories]) {
    const buffer = await client.downloadMedia(story.media);
    if (buffer) {
      result.push({
        buffer,
        mediaType: 'photo' in story.media ? 'photo' : 'video',
      });
    }
  }

  return result;
}
```

• Send downloaded stories to user using Telegraf api (not Gramjs's userbot):

```typescript
import { Telegraf } from 'telegraf';

const bot = new Telegraf(BOT_TOKEN);
bot.telegram.sendMediaGroup(
  chatId,
  stories.map((story) => ({
    media: { source: story.buffer },
    type: story.mediaType,
  })),
);
```

<h2>🧰 Tools Used</h2>

🤖 <a href="https://gram.js.org/">GramJS</a> 🤖 - Provides access to the Telegram client API based on MTProto

👾 <a href="https://telegraf.js.org/">Telegraf</a> 👾 - Provides access to the Telegram bot API

☄️ <a href="https://effector.dev/">Effector</a> ☄️ - used for writing the business logic of the app, ensuring efficient state management and handling of complex workflows

<h2>🛠 Setup</h2>
<p>The project can be run entirely through Docker without any manual build steps.</p>

1. Copy <code>.env.example</code> to <code>.env</code> and fill in the required values:
   - <code>DEV_BOT_TOKEN</code> or <code>PROD_BOT_TOKEN</code> – get your bot token from <a href="https://t.me/BotFather">BotFather</a>.
   - <code>USERBOT_API_ID</code> and <code>USERBOT_API_HASH</code> – obtain these from <a href="https://my.telegram.org">my.telegram.org</a>.
   - <code>USERBOT_PHONE_NUMBER</code> – the phone number of the account that will act as the userbot.
   - Optional: <code>USERBOT_PASSWORD</code> if that account has two‑factor authentication enabled.
   - Leave <code>USERBOT_PHONE_CODE</code> empty for the first run.
   - Fill in <code>BOT_ADMIN_ID</code>, <code>BTC_WALLET_ADDRESS</code>, etc.
  - Optional: <code>LOG_FILE</code> to change where runtime errors are logged (defaults to <code>./data/error.log</code>).
  - Optional: <code>DEBUG_LOG_FILE</code> to also store verbose debug logs on disk. Leave empty to disable file logging.
2. Build and start the container:

```shell
docker compose up -d
```

The first start will fail with <code>USERBOT_PHONE_CODE is required for first login!</code>.
Telegram will send a login code to the phone number specified in <code>USERBOT_PHONE_NUMBER</code>.
Add this code to your <code>.env</code> as <code>USERBOT_PHONE_CODE</code> and run the command again.
Once authentication completes the session file is saved, so you can remove the
<code>USERBOT_PHONE_CODE</code> line from the environment file.

### Viewing Logs

Use <code>docker logs ghost-stories-bot</code> to see recent output from the running container.
Runtime errors are also written to the file specified by <code>LOG_FILE</code> (default <code>./data/error.log</code>).
Verbose output from <code>console.log</code> and other statements always appears in the container logs. Set <code>DEBUG_LOG_FILE</code> if you also want a persistent copy on disk.

<h2>🚀 Usage</h2>
Just send a message to the bot with the desired Telegram username, phone number, or the direct link to story. Wait for the bot to retrieve and deliver the stories back to you

### Monitoring Profiles

Free users cannot monitor profiles. Premium users can monitor up to **5** profiles for new stories, while admins have no limit. Each monitored account is checked every **6 hours** on its own schedule. Use `/monitor <@username|+19875551234>` to add a profile by username or phone number (digits only, no hyphens), and `/unmonitor <@username>` to remove one. After adding a monitor, the bot tells you how many slots you have left. Send `/monitor` or `/unmonitor` without arguments to see your current list.

### Manual Payment Verification

If your upgrade payment is not confirmed within an hour, you can verify it manually. Locate the invoice number in the upgrade reply (for example `Invoice #42`) and obtain the transaction hash (TXID) from your wallet. Then run:

```
/verify <txid> <invoice_id>
```

The bot will check the blockchain immediately and credit Premium time if the amount matches.

## Development

Before running any build or lint commands, install dependencies:

```shell
yarn install
# or
./setup.sh
```

### Build

```shell
yarn build
```

### Lint

```shell
yarn lint
```
