import { TelegramClient } from 'telegram';
import { StoreSession } from 'telegram/sessions';

import {
  USERBOT_API_HASH,
  USERBOT_API_ID,
  USERBOT_PHONE_NUMBER,
  USERBOT_PASSWORD,      // <-- Add these to env-config and your deployment ENV
  USERBOT_PHONE_CODE     // <-- Add these to env-config and your deployment ENV
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

  // Get code and password from ENV
  const password = USERBOT_PASSWORD || undefined;
  const phoneCode = USERBOT_PHONE_CODE || undefined;

  // Optional: Print warning if these are missing (will cause login to fail)
  if (!phoneCode) {
    console.warn("Warning: USERBOT_PHONE_CODE is not set! You must provide it on first login.");
  }
  // For security, don't print password

  await client.start({
    phoneNumber: USERBOT_PHONE_NUMBER,
    password: password ? async () => password : undefined,
    phoneCode: phoneCode ? async () => phoneCode : undefined,
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
