import { config } from 'dotenv';

const { parsed } = config();

const getEnvVar = (key: string): string => {
  const value = process.env[key] ?? parsed?.[key];
  if (!value) {
    throw new Error(`Env variable ${key} is required`);
  }
  return value;
};

/** Runtime mode */
export const NODE_ENV = getEnvVar('NODE_ENV');
/** Dev mode */
export const isDevEnv = NODE_ENV === 'development';
/** Prod mode */
export const isProdEnv = NODE_ENV === 'production';

/** bot's token */
export const BOT_TOKEN = isDevEnv
  ? getEnvVar('DEV_BOT_TOKEN')
  : getEnvVar('PROD_BOT_TOKEN');

/** Telegram id of bot admin */
export const BOT_ADMIN_ID = Number(getEnvVar('BOT_ADMIN_ID'));

// userbot
export const USERBOT_API_ID = Number(getEnvVar('USERBOT_API_ID'));
export const USERBOT_API_HASH = getEnvVar('USERBOT_API_HASH');
export const USERBOT_PHONE_NUMBER = getEnvVar('USERBOT_PHONE_NUMBER');
export const USERBOT_PASSWORD = process.env.USERBOT_PASSWORD || parsed?.USERBOT_PASSWORD || '';
export const USERBOT_PHONE_CODE = process.env.USERBOT_PHONE_CODE || parsed?.USERBOT_PHONE_CODE || '';

// supabase
export const SUPABASE_PROJECT_URL = getEnvVar('SUPABASE_PROJECT_URL');
export const SUPABASE_API_KEY = getEnvVar('SUPABASE_API_KEY');
