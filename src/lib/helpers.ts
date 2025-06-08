// src/lib/helpers.ts

// CORRECTED: Import StoriesModel and MappedStoryItem from your central types.ts file
import { StoriesModel, MappedStoryItem } from 'types'; // <--- This import is now correct and centralized

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
