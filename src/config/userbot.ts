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
  private static client: TelegramClient;

  public static async getInstance() {
    if (!Userbot.client) {
      // FIXME: RACE CONDITION ISSUE
      Userbot.client = await initClient();
    }
    return Userbot.client;
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
