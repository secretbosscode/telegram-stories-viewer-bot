// src/lib/helpers.ts

// CORRECTED: Import StoriesModel and MappedStoryItem from your central types.ts file
import { StoriesModel, MappedStoryItem } from 'types'; // <--- This import is now correct and centralized
import {
  getPinnedMessageId,
  setPinnedMessageId,
  getPinnedMessageUpdatedAt,
  setPinnedMessageUpdatedAt,
} from 'repositories/user-repository';
import * as bitcoin from 'bitcoinjs-lib';
import { t } from 'lib/i18n';

const MAX_STORIES_SIZE = 45;

// Wait for the specified time in milliseconds
export const timeout = (ms: number): Promise<null> =>
  new Promise((ok) => setTimeout(ok, ms));

// Conditions under which the scheduled delete is expected to fail and there is
// nothing to recover: the message is already gone, or the chat is unreachable.
// These must not be logged at error level — every console.error is mirrored to
// the debug log and fed into the connection-failure watchdog.
const MESSAGE_ALREADY_GONE =
  /message to delete not found|message can't be deleted|MESSAGE_ID_INVALID|message identifier is not specified|bot was blocked by the user|chat not found|user is deactivated|bot was kicked/i;

// Send a Telegram message and automatically delete it after a delay.
// Returns the message id so callers can cancel or replace it themselves.
export async function sendTemporaryMessage(
  bot: import('telegraf').Telegraf<any>,
  chatId: number | string,
  text: string,
  options?: Parameters<typeof bot.telegram.sendMessage>[2],
  delayMs = 30_000,
): Promise<number | undefined> {
  const msg = await bot.telegram.sendMessage(chatId, text, options);
  const timer = setTimeout(async () => {
    try {
      await bot.telegram.deleteMessage(chatId, msg.message_id);
    } catch (err) {
      const description = String(
        (err as any)?.response?.description ?? (err as any)?.description ?? (err as any)?.message ?? '',
      );
      if (MESSAGE_ALREADY_GONE.test(description)) return;
      console.warn('Failed to delete temporary message:', description);
    }
  }, delayMs);
  // Do not keep the process alive purely to delete a transient notice.
  timer.unref?.();
  return msg.message_id;
}

// Telegram accepts 2-10 items per media group and rejects an empty array.
const TELEGRAM_ALBUM_LIMIT = 10;

export function chunkMediafiles(files: StoriesModel): MappedStoryItem[][] {
  const chunks = files.reduce(
    (acc: MappedStoryItem[][], curr: MappedStoryItem) => {
      const current = acc[acc.length - 1];
      // An item that exceeds the size budget on its own still has to go
      // somewhere. Placing it in the current chunk when that chunk is empty
      // avoids emitting a leading empty album, which sendMediaGroup rejects and
      // which previously aborted the rest of the batch.
      if (current.length === 0) {
        current.push(curr);
        return acc;
      }
      const tempAccWithCurr = [...current, curr];
      if (
        tempAccWithCurr.length > TELEGRAM_ALBUM_LIMIT ||
        sumOfSizes(tempAccWithCurr) >= MAX_STORIES_SIZE
      ) {
        acc.push([curr]);
        return acc;
      }
      current.push(curr);
      return acc;
    },
    [[]] as MappedStoryItem[][]
  );
  // Guard against a trailing/leading empty group for an empty input.
  return chunks.filter((chunk) => chunk.length > 0);
}

function sumOfSizes(list: { bufferSize?: number }[]): number { // Added return type
  return list.reduce((acc: number, curr: { bufferSize?: number }) => { // CORRECTED: Explicitly typed 'acc' and 'curr'
    if (curr.bufferSize) {
      return acc + curr.bufferSize;
    }
    return acc;
  }, 0);
}

export function getRandomArrayItem<T>(arr: T[], prevValue?: T): T {
  const filteredArr = arr.filter((value) => value !== prevValue);
  const randomIndex = Math.floor(Math.random() * filteredArr.length);
  return filteredArr[randomIndex];
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// Split long text into multiple messages to stay under Telegram's 4096
// character limit. Sends each chunk sequentially using ctx.reply.
export async function replyChunks(
  ctx: import('telegraf').Context,
  text: string,
  extra?: Parameters<typeof ctx.reply>[1],
): Promise<void> {
  const MAX_LEN = 4096;
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if ((chunk + line + '\n').length > MAX_LEN) {
      await ctx.reply(chunk, extra);
      chunk = '';
    }
    chunk += line + '\n';
  }
  if (chunk) {
    await ctx.reply(chunk, extra);
  }
}

// Update or create a pinned message showing remaining Premium time

export async function updatePremiumPinnedMessage(
  bot: import('telegraf').Telegraf<any>,
  chatId: number | string,
  telegramId: string,
  daysLeft: number,
  locale: string | undefined,
  force = false,
): Promise<void> {
  const lastUpdated = getPinnedMessageUpdatedAt(telegramId);
  const now = Math.floor(Date.now() / 1000);
  if (!force && lastUpdated && now - lastUpdated < 86400) {
    return;
  }
  const daysText =
    daysLeft === Infinity ? t(locale, 'premium.unlimited') : daysLeft.toString();
  const text = t(locale, 'premium.pinnedMessage', {
    days: daysText,
    plural: daysLeft === 1 ? '' : 's',
  });
  const pinnedId = getPinnedMessageId(telegramId);
  if (pinnedId) {
    try {
      await bot.telegram.editMessageText(chatId, pinnedId, undefined, text);
      setPinnedMessageUpdatedAt(telegramId, now);
      return;
    } catch (err) {
      // message might have been deleted or can't be edited
    }
  }

  try {
    await bot.telegram.unpinChatMessage(chatId).catch(() => {});
    const msg = await bot.telegram.sendMessage(chatId, text);
    await bot.telegram.pinChatMessage(chatId, msg.message_id, {
      disable_notification: true,
    });
    setPinnedMessageId(telegramId, msg.message_id);
    setPinnedMessageUpdatedAt(telegramId, now);
  } catch (err) {
    console.error('Failed to update premium pinned message', err);
  }
}

// Validate a bitcoin address string. Returns true if the address is valid for
// the Bitcoin mainnet, otherwise false.
export function isValidBitcoinAddress(address: string): boolean {
  try {
    bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin);
    return true;
  } catch {
    return false;
  }
}

// Validate if a link matches the Telegram story URL format.
// Accepted formats:
//   https://t.me/username/s/123
//   http://t.me/username/s/123
//   t.me/username/s/123
export function isValidStoryLink(link: string): boolean {
  return /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[^\/]+\/s\/\d+\/?$/i.test(
    link.trim(),
  );
}

// Check if the provided string is a phone number in international format
export function isPhoneNumber(text: string): boolean {
  return /^\+\d{5,15}$/.test(text.trim());
}
