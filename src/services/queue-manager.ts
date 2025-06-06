// src/services/queue-manager.ts

import {
  enqueueDownload,
  getNextQueueItem,
  markProcessing,
  markDone,
  markError,
  cleanupQueue,
  wasRecentlyDownloaded,
  isDuplicatePending,
} from 'db/index'; // Corrected import path to use tsconfig alias
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index'; // Corrected import path to use tsconfig alias
import { UserInfo, DownloadQueueItem } from 'types'; // Corrected import path for types

/**
 * Cooldown hours by user type
 */
const COOLDOWN_HOURS = {
  free: 12,
  premium: 2,
  admin: 0,
};

/**
 * Get cooldown period for user (in hours)
 */
function getCooldownHours({ isPremium, isAdmin }: { isPremium?: boolean; isAdmin?: boolean }) {
  if (isAdmin) return COOLDOWN_HOURS.admin;
  if (isPremium) return COOLDOWN_HOURS.premium;
  return COOLDOWN_HOURS.free;
}

/**
 * Handles a new download request: checks abuse, prevents duplicate, queues job.
 */
export async function handleNewTask(user: UserInfo) {
  const telegram_id = user.chatId;
  const target_username = user.link;
  const is_admin = telegram_id === BOT_ADMIN_ID.toString();
  const is_premium = !!user.isPremium;
  const cooldown = getCooldownHours({ isPremium: is_premium, isAdmin: is_admin });

  // Check if user has recently downloaded this target (anti-abuse)
  if (await wasRecentlyDownloaded(telegram_id, target_username, cooldown)) {
    await bot.telegram.sendMessage(
      telegram_id,
      `⏳ Please wait before downloading ${target_username} again. Try later.`
    );
    return;
  }

  // Prevent duplicate pending jobs in queue
  if (await isDuplicatePending(telegram_id, target_username)) {
    await bot.telegram.sendMessage(
      telegram_id,
      `⚠️ This download is already queued for you. Please wait for it to finish.`
    );
    return;
  }

  // Insert into queue
  await enqueueDownload(telegram_id, target_username);
  await bot.telegram.sendMessage(telegram_id, `✅ Download for ${target_username} queued!`);
  processQueue(); // Try to process immediately if nothing running
}

let isProcessing = false;

/**
 * Process the next job in the queue.
 * Uses DB to pull the next eligible job and marks status through lifecycle.
 */
export async function processQueue() {
  if (isProcessing) return;
  // Ensure getNextQueueItem() in db/index.ts is typed to return DownloadQueueItem | null
  const job: DownloadQueueItem | null = await getNextQueueItem(); // Awaiting result from DB
  if (!job) return;

  isProcessing = true;
  await markProcessing(job.id); // job.id is now string, markProcessing parameter type should be string

  try {
    // ---- Replace this block with your real download logic! ----
    // E.g. await downloadStories(job.chatId, job.task.link); // Example of using correct properties
    await new Promise((res) => setTimeout(res, 2000)); // Dummy delay for example
    // ----------------------------------------------------------

    await markDone(job.id); // job.id is now string, markDone parameter type should be string
    await bot.telegram.sendMessage(
      job.chatId, // Corrected from job.telegram_id
      `🎉 Download for ${job.task.link} completed!` // Corrected from job.target_username
    );
  } catch (err: any) {
    await markError(job.id, err?.message || 'Unknown error'); // job.id is now string, markError parameter type should be string
    await bot.telegram.sendMessage(
      job.chatId, // Corrected from job.telegram_id
      `❌ Download failed for ${job.task.link}: ${err?.message || ''}` // Corrected from job.target_username
    );
  }

  isProcessing = false;
  await cleanupQueue();
  setImmediate(processQueue); // Automatically process next job in queue
}
