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
} from '../db/index';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from '../index';
import { UserInfo } from '../types/user-info';
import { DownloadQueueItem } from '../types/download-queue-item';

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
  if (wasRecentlyDownloaded(telegram_id, target_username, cooldown)) {
    await bot.telegram.sendMessage(
      telegram_id,
      `⏳ Please wait before downloading ${target_username} again. Try later.`
    );
    return;
  }

  // Prevent duplicate pending jobs in queue
  if (isDuplicatePending(telegram_id, target_username)) {
    await bot.telegram.sendMessage(
      telegram_id,
      `⚠️ This download is already queued for you. Please wait for it to finish.`
    );
    return;
  }

  // Insert into queue
  enqueueDownload(telegram_id, target_username);
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
  const job: DownloadQueueItem | null = getNextQueueItem();
  if (!job) return;

  isProcessing = true;
  markProcessing(job.id);

  try {
    // ---- Replace this block with your real download logic! ----
    // E.g. await downloadStories(job.telegram_id, job.target_username);
    await new Promise((res) => setTimeout(res, 2000)); // Dummy delay for example
    // ----------------------------------------------------------

    markDone(job.id);
    await bot.telegram.sendMessage(
      job.telegram_id,
      `🎉 Download for ${job.target_username} completed!`
    );
  } catch (err: any) {
    markError(job.id, err?.message || 'Unknown error');
    await bot.telegram.sendMessage(
      job.telegram_id,
      `❌ Download failed for ${job.target_username}: ${err?.message || ''}`
    );
  }

  isProcessing = false;
  cleanupQueue();
  setImmediate(processQueue); // Automatically process next job in queue
}
