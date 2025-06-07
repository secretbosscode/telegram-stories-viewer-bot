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
} from 'db/index'; 
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { UserInfo, DownloadQueueItem, SendStoriesFxParams } from 'types';

// =========================================================================
// FINAL FIX: Import the effects that do the actual work.
// =========================================================================
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendStoriesFx } from 'controllers/send-stories';


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
 * This is the main entry point called by your index.ts.
 */
export async function handleNewTask(user: UserInfo) {
  const telegram_id = user.chatId;
  const target_username = user.link;
  const is_admin = telegram_id === BOT_ADMIN_ID.toString();
  const is_premium = !!user.isPremium;
  const cooldown = getCooldownHours({ isPremium: is_premium, isAdmin: is_admin });

  try {
    if (await wasRecentlyDownloaded(telegram_id, target_username, cooldown)) {
        await bot.telegram.sendMessage(telegram_id, `⏳ You can request stories for "${target_username}" once every ${cooldown} hours.`);
        return;
    }

    if (await isDuplicatePending(telegram_id, target_username)) {
        await bot.telegram.sendMessage(telegram_id, `⚠️ This download is already in the queue. Please wait.`);
        return;
    }

    await enqueueDownload(telegram_id, target_username, user);
    await bot.telegram.sendMessage(telegram_id, `✅ Your request for ${target_username} has been queued!`);
    
    // Use setImmediate to avoid blocking and ensure the current context finishes.
    setImmediate(processQueue);
  } catch(e: any) {
    console.error('[handleNewTask] Error during task validation/enqueueing:', e);
    await bot.telegram.sendMessage(telegram_id, `❌ Sorry, an error occurred while queueing your request.`);
  }
}

let isProcessing = false;

/**
 * Process the next job in the queue. This function acts as our main worker loop.
 */
export async function processQueue() {
  if (isProcessing) return; // Prevent multiple concurrent processing loops

  const job: DownloadQueueItem | null = await getNextQueueItem();
  if (!job) {
    // No jobs in the queue, we can exit.
    return;
  }

  isProcessing = true;
  await markProcessing(job.id);
  
  // Combine the DB data with the nested task details to create the full UserInfo object
  const currentTask: UserInfo = { ...job.task, chatId: job.chatId, instanceId: job.id };

  try {
    // =========================================================================
    // FINAL FIX: This is the real story fetching and sending logic.
    // =========================================================================
    console.log(`[QueueManager] Starting processing for ${currentTask.link}`);
    
    // 1. Fetch the stories from Telegram
    let storiesResult;
    if (currentTask.linkType === 'username') {
        storiesResult = await getAllStoriesFx(currentTask);
    } else {
        storiesResult = await getParticularStoryFx(currentTask);
    }

    // 2. Check for string-based error messages from the fetchers
    if (typeof storiesResult === 'string') {
        throw new Error(storiesResult);
    }

    // 3. Send the stories to the user
    const payload: SendStoriesFxParams = { task: currentTask, ...(storiesResult as object) };
    await sendStoriesFx(payload);
    
    // 4. Mark the job as done in the database
    await markDone(job.id);

  } catch (err: any) {
    console.error(`[QueueManager] Error processing job ${job.id} for ${currentTask.link}:`, err);
    // If anything fails, mark the job as an error in the database
    await markError(job.id, err?.message || 'Unknown processing error');
    // Notify the user of the failure
    await bot.telegram.sendMessage(job.chatId, `❌ Your download for ${currentTask.link} failed. Reason: ${err?.message || 'Unknown error'}`);
  }

  isProcessing = false;
  
  // Optional: Clean up very old jobs from the queue
  await cleanupQueue();
  
  // Immediately check for the next job.
  setImmediate(processQueue);
}

// Start the queue processor when the bot starts, in case there are leftover jobs from a previous run.
console.log('[QueueManager] Initializing queue processor...');
setImmediate(processQueue);
