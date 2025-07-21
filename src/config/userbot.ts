import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { recordTimeoutError } from './timeout-monitor';

import {
  USERBOT_API_HASH,
  USERBOT_API_ID,
  USERBOT_PHONE_NUMBER,
  USERBOT_PASSWORD,
  USERBOT_PHONE_CODE
} from './env-config';

export class Userbot {
  private static client: TelegramClient | null = null;
  private static initPromise: Promise<TelegramClient> | null = null;
  private static monitor: NodeJS.Timeout | null = null;
  private static readonly CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

  /**
   * Force reinitialization of the Telegram client. Useful when the session
   * becomes invalid (e.g. AUTH_KEY_UNREGISTERED) and we need a fresh login.
   */
  public static async reset(): Promise<void> {
    if (Userbot.client) {
      try {
        await Userbot.client.disconnect();
      } catch (e) {
        console.error('[Userbot] Error while disconnecting:', e);
      }
    }
    Userbot.client = null;
    Userbot.initPromise = null;
  }

  /**
   * Returns singleton instance of TelegramClient. To avoid a race condition
   * when multiple parts of the app request the client simultaneously, the
   * first call stores the initialization promise and subsequent calls await the
   * same promise until initialization finishes.
   */
  public static async getInstance(): Promise<TelegramClient> {
    if (Userbot.client) return Userbot.client;

    if (!Userbot.initPromise) {
      Userbot.initPromise = initClient()
        .then((client) => {
          Userbot.client = client;
          Userbot.initPromise = null;
          return client;
        })
        .catch((err) => {
          Userbot.initPromise = null;
          throw err;
        });
    }

    return Userbot.initPromise;
  }

  private static async checkConnection(): Promise<void> {
    if (!Userbot.client) return;
    try {
      await Userbot.client.invoke(new Api.updates.GetState());
    } catch (err) {
      console.error('[Userbot] Connection check failed:', err);
      recordTimeoutError(err);
      await Userbot.reset();
      try {
        await Userbot.getInstance();
        console.log('[Userbot] Reconnected after connection failure.');
      } catch (re) {
        console.error('[Userbot] Reconnection attempt failed:', re);
      }
    }
  }

  public static startConnectionMonitor(): void {
    if (Userbot.monitor) return;
    Userbot.monitor = setInterval(() => {
      Userbot.checkConnection().catch((e) =>
        console.error('[Userbot] Connection monitor error:', e)
      );
    }, Userbot.CHECK_INTERVAL_MS);
  }
}

async function initClient() {
  // Load the stored session string from /data if it exists
  const sessionFile = path.join('/data', 'userbot-session');
  let sessionStr = '';
  try {
    sessionStr = fs.readFileSync(sessionFile, 'utf8');
  } catch {}
  const stringSession = new StringSession(sessionStr);

  const client = new TelegramClient(
    stringSession,
    USERBOT_API_ID,
    USERBOT_API_HASH,
    {
      connectionRetries: 5,
    }
  );

  const password = USERBOT_PASSWORD || '';
  let phoneCode = USERBOT_PHONE_CODE || '';

  const promptInput = async (query: string): Promise<string> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) =>
      rl.question(query, (answer) => {
        rl.close();
        resolve(answer.trim());
      }),
    );
  };

  await client.start({
    phoneNumber: USERBOT_PHONE_NUMBER,
    password: async () => {
      if (password) return password;
      return promptInput('Please enter two-factor authentication password: ');
    },
    phoneCode: async (_isCodeViaApp?: boolean) => {
      if (!phoneCode) {
        phoneCode = await promptInput('Please enter the Telegram login code: ');
      }
      if (!phoneCode) throw new Error('USERBOT_PHONE_CODE is required for first login!');
      return phoneCode;
    },
    onError: (err) => {
      console.log('error', err);
      recordTimeoutError(err);
    },
  });

  console.log('You should now be connected.');
  const saved = client.session.save() as unknown as string;
  console.log(saved); // Save the session to avoid logging in again
  try {
    fs.writeFileSync(sessionFile, saved);
  } catch (err) {
    console.error('[Userbot] Failed to write session', err);
  }
  await client.sendMessage('me', { message: 'Hi!' });
  return client;
}

export async function initUserbot() {
  await Userbot.getInstance(); // init
  Userbot.startConnectionMonitor();
  console.log('userbot initiated');
}
