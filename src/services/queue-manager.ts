// src/services/queue-manager.ts

import {
  enqueueDownloadFx,
  getNextQueueItemFx,
  markProcessingFx,
  markDoneFx,
  markErrorFx,
  cleanupQueueFx,
  wasRecentlyDownloadedFx,
  isDuplicatePendingFx,
} from 'db/effects'; 
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { UserInfo, DownloadQueueItem, SendStoriesFxParams } from 'types';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendStoriesFx } from 'controllers/send-stories';

const COOLDOWN_HOURS = { free: 12, premium: 2, admin: 0 };

function getCooldownHours({ isPremium, isAdmin }: { isPremium?: boolean; isAdmin?: boolean }) {
  if (isAdmin) return COOLDOWN_HOURS.admin;
  if (isPremium) return COOLDOWN_HOURS.premium;
  return COOLDOWN_HOURS.free;
}

/**
 * Handles a new download request from the user.
 * This is the main entry point called by your index.ts.
 */
export async function handleNewTask(user: UserInfo) {
  const { chatId: telegram_id, link: target_username } = user;
  const is_admin = telegram_id === BOT_ADMIN_ID.toString();
  const cooldown = getCooldownHours({ isPremium: user.isPremium, isAdmin: is_admin });

  try {
    if (await wasRecentlyDownloadedFx({ telegram_id, target_username, hours: cooldown })) {
        await bot.telegram.sendMessage(telegram_id, `⏳ You can request stories for "${target_username}" once every ${cooldown} hours.`);
        return;
    }
    if (await isDuplicatePendingFx({ telegram_id, target_username })) {
        await bot.telegram.sendMessage(telegram_id, `⚠️ This download is already in the queue. Please wait.`);
        return;
    }

    await enqueueDownloadFx({ telegram_id, target_username, task_details: user });
    await bot.telegram.sendMessage(telegram_id, `✅ Your request for ${target_username} has been queued!`);
    
    // After successfully queueing, poke the processor to start immediately if it's idle.
    setImmediate(processQueue);
  } catch(e: any) {
    console.error('[handleNewTask] Error during task validation/enqueueing:', e);
    await bot.telegram.sendMessage(telegram_id, `❌ An error occurred while queueing your request.`);
  }
}

let isProcessing = false;

/**
 * Processes one item from the queue and then immediately calls itself
 * to create a resilient, continuous processing loop.
 */
export async function processQueue() {
  // Use a simple lock to prevent multiple loops from running at the exact same time.
  if (isProcessing) return;

  const job: DownloadQueueItem | null = await getNextQueueItemFx();
  
  // If the queue is empty, stop the loop. It will be re-awakened by the next handleNewTask call.
  if (!job) {
    return;
  }

  isProcessing = true;
  await markProcessingFx(job.id);
  
  // Reconstruct the full task object from the database record.
  const currentTask: UserInfo = { ...job.task, chatId: job.chatId, instanceId: job.id };

  try {
    console.log(`[QueueManager] Starting processing for ${currentTask.link} (Job ID: ${job.id})`);
    
    const storiesResult = currentTask.linkType === 'username'
      ? await getAllStoriesFx(currentTask)
      : await getParticularStoryFx(currentTask);

    if (typeof storiesResult === 'string') {
      // This allows get-stories to return user-friendly error messages.
      throw new Error(storiesResult);
    }

    const payload: Send
