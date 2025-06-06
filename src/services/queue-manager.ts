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
import { bot } from '../index'; // Adjust if your bot instance path is different
import { UserInfo } from '../types/user-info'; // The interface you created

// ===== Cooldown settings for anti-abuse (in hours) =====
const COOLDOWN_HOURS = { free: 12, premium: 2, admin: 0 };

/**
 * Returns cooldown hours based on user type.
 */
function getCooldownHours({ isPremium, isAdmin }: { isPremium?: boolean; isAdmin?: boolean }) {
  if (isAdmin) return COOLDOWN_HOURS.admin;
  if (isPremium) return COOLDOWN_HOURS.premium;
  return COOLDOWN_HOURS.free;
}

/**
 * Called when a new task is requested by user.
 * Checks for cooldown/abuse/duplicate, enqueues task in DB, notifies user.
 */
export async function handleNewTask(user: UserInfo) {
  const telegram_id = user.chatId;
  const target_username = user.link;
  const is_admin = telegram_id === BOT_ADMIN_ID.toString();
  const is_premium = !!user.isPremium;
  const cooldown = getCooldownHours({ isPremium: is_premium, isAdmin: is_admin });

  // Check if user recently downloaded this target (abuse prevention)
  if (wasRecentlyDownloaded(telegram_id, target_username, cooldown)) {
    await bot.telegram.sendMessage(
      telegram_id,
      `⏳ Please wait before downloading ${target_username} again. Try later.`
    );
    return;
  }

  // Prevent duplicate jobs for same user/target while pending/processing
  if (isDuplicatePending(telegram_id, target_username)) {
    await bot.telegram.sendMessage(
      telegram_id,
      `⚠️ This download is already queued for you. Please wait for it to finish.`
    );
    return;
  }

  // Insert job into DB-backed queue
  enqueueDownload(telegram_id, target_username);
  await bot.telegram.sendMessage(telegram_id, `✅ Download for ${target_username} queued!`);
  processQueue(); // Try to process immediately if nothing running
}

// ---- Only one download runs at a time ----
let isProcessing = false;

/**
 * Processes jobs from the DB queue one-by-one, FIFO, respecting priority.
 * Calls markProcessing, markDone, markError as job progresses.
 * On job completion, notifies user and recursively processes next.
 */
export async function processQueue() {
  if (isProcessing) return; // Only one at a time!
  const job = getNextQueueItem();
  if (!job) return;

  isProcessing = true;
  markProcessing(job.id);

  try {
    // TODO: Replace this block with real download logic!
    // For demo: Simulate download with a timeout
    // await realDownloadStoriesFx({ ...job });
    await new Promise((res) => setTimeout(res, 2000)); // fake work

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
  cleanupQueue(); // Remove old jobs
  setImmediate(processQueue); // Process next in queue, if any
}
