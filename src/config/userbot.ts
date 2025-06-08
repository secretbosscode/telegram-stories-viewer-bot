import { TelegramClient } from 'telegram';
import { StoreSession } from 'telegram/sessions';

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
}

async function initClient() {
  const storeSession = new StoreSession('userbot-session');

  const client = new TelegramClient(
    storeSession,
    USERBOT_API_ID,
    USERBOT_API_HASH,
    {
      connectionRetries: 5,
    }
  );

  const password = USERBOT_PASSWORD || '';
  const phoneCode = USERBOT_PHONE_CODE || '';

  await client.start({
    phoneNumber: USERBOT_PHONE_NUMBER,
    password: async () => {
      if (!password) throw new Error('USERBOT_PASSWORD is required for this account!');
      return password;
    },
    phoneCode: async (_isCodeViaApp?: boolean) => {
      if (!phoneCode) throw new Error('USERBOT_PHONE_CODE is required for first login!');
      return phoneCode;
    },
    onError: (err) => console.log('error', err),
  });

  console.log('You should now be connected.');
  console.log(client.session.save()); // Save the session to avoid logging in again
  await client.sendMessage('me', { message: 'Hi!' });
  return client;
}

export async function initUserbot() {
  await Userbot.getInstance(); // init
  console.log('userbot initiated');
}
