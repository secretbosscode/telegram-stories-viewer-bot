import { config } from 'dotenv';
import path from 'path';

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

// payments
export const BTC_XPUB = process.env.BTC_XPUB || parsed?.BTC_XPUB || '';
export const BTC_YPUB = process.env.BTC_YPUB || parsed?.BTC_YPUB || '';
export const BTC_ZPUB = process.env.BTC_ZPUB || parsed?.BTC_ZPUB || '';
export const BTC_WALLET_ADDRESS =
  process.env.BTC_WALLET_ADDRESS || parsed?.BTC_WALLET_ADDRESS || '';
if (!BTC_WALLET_ADDRESS && !BTC_XPUB && !BTC_YPUB && !BTC_ZPUB) {
  throw new Error(
    'Either BTC_WALLET_ADDRESS, BTC_XPUB, BTC_YPUB or BTC_ZPUB is required',
  );
}

// Base directory for all runtime data inside the container. Docker mounts a
// persistent host directory here.
export const DATA_DIR = '/data';

// error log file path
export const LOG_FILE =
  process.env.LOG_FILE || parsed?.LOG_FILE || path.join(DATA_DIR, 'error.log');

// verbose debugging
/**
 * When `DEBUG_LOG` is truthy all console output is mirrored to
 * `/data/debug.log` (inside the container). The path is fixed so the user
 * does not need to provide it.
 */
export const DEBUG_LOG = (() => {
  const flag = process.env.DEBUG_LOG ?? parsed?.DEBUG_LOG ?? '';
  return ['1', 'true', 'yes'].includes(String(flag).toLowerCase());
})();

// Debug log file path is always relative to the application data directory
export const DEBUG_LOG_FILE = path.join(DATA_DIR, 'debug.log');
