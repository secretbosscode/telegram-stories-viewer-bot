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

const MAX_STORIES_SIZE = 45;

// Wait for the specified time in milliseconds
export const timeout = (ms: number): Promise<null> =>
  new Promise((ok) => setTimeout(ok, ms));

// Send a Telegram message and automatically delete it after a delay
export async function sendTemporaryMessage(
  bot: import('telegraf').Telegraf<any>,
  chatId: number | string,
  text: string,
  options?: Parameters<typeof bot.telegram.sendMessage>[2],
  delayMs = 60_000,
): Promise<void> {
  const msg = await bot.telegram.sendMessage(chatId, text, options);
  setTimeout(() => {
    bot.telegram.deleteMessage(chatId, msg.message_id).catch(() => {
      /* ignore deletion errors */
    });
  }, delayMs);
}

export function chunkMediafiles(files: StoriesModel): MappedStoryItem[][] { // Added return type and parameter type
  return files.reduce(
    (acc: MappedStoryItem[][], curr: MappedStoryItem) => { // CORRECTED: Explicitly typed 'acc' and 'curr'
      const tempAccWithCurr = [...acc[acc.length - 1], curr];
      if (
        tempAccWithCurr.length === 10 ||
        sumOfSizes(tempAccWithCurr) >= MAX_STORIES_SIZE
      ) {
        acc.push([curr]);
        return acc;
      }
      acc[acc.length - 1].push(curr);
      return acc;
    },
    [[]]
  );
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

// Update or create a pinned message showing remaining Premium time

export async function updatePremiumPinnedMessage(
  bot: import('telegraf').Telegraf<any>,
  chatId: number | string,
  telegramId: string,
  daysLeft: number,
  force = false,
): Promise<void> {
  const lastUpdated = getPinnedMessageUpdatedAt(telegramId);
  const now = Math.floor(Date.now() / 1000);
  if (!force && lastUpdated && now - lastUpdated < 86400) {
    return;
  }
  const daysText = daysLeft === Infinity ? 'unlimited' : daysLeft.toString();
  const text = `🌟 Premium: ${daysText} day${daysLeft === 1 ? '' : 's'} remaining`;
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
