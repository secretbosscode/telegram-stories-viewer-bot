// src/services/queue-manager.ts

import { createEffect } from 'effector';
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
      await bot.telegram.sendMessage(telegram_id, `⚠️ This download is already in the queue.`);
      return;
    }

    await enqueueDownloadFx({ telegram_id, target_username, task_details: user });
    await bot.telegram.sendMessage(telegram_id, `✅ Your request for ${target_username} has been queued!`);
    
    // Trigger the queue processor immediately in case it's idle.
    setImmediate(processQueue);
  } catch(e: any) {
    console.error('[handleNewTask] Error during task validation/enqueueing:', e);
    await bot.telegram.sendMessage(telegram_id, `❌ An error occurred while queueing your request.`);
  }
}

let isProcessing = false;

export async function processQueue() {
  if (isProcessing) {
    console.log('[QueueManager] Processor is already running. Exiting this loop.');
    return;
  }

  const job: DownloadQueueItem | null = await getNextQueueItemFx();
  if (!job) {
    console.log('[QueueManager] Queue is empty. Processor is going to sleep.');
    return;
  }

  isProcessing = true;
  await markProcessingFx(job.id);
  
  const currentTask: UserInfo = { ...job.task, chatId: job.chatId, instanceId: job.id };

  try {
    console.log(`[QueueManager] Starting processing for ${currentTask.link} (Job ID: ${job.id})`);
    
    let storiesResult;
    if (currentTask.linkType === 'username') {
        storiesResult = await getAllStoriesFx(currentTask);
    } else {
        storiesResult = await getParticularStoryFx(currentTask);
    }

    if (typeof storiesResult === 'string') {
        throw new Error(storiesResult);
    }

    const payload: SendStoriesFxParams = { task: currentTask, ...(storiesResult as object) };
    await sendStoriesFx(payload);
    
    await markDoneFx(job.id);
    console.log(`[QueueManager] Finished processing for ${currentTask.link} (Job ID: ${job.id})`);

  } catch (err: any) {
    console.error(`[QueueManager] Error processing job ${job.id} for ${currentTask.link}:`, err);
    await markErrorFx({ jobId: job.id, message: err?.message || 'Unknown processing error' });
    // The user-facing error message is now handled inside send-stories.ts
  }

  isProcessing = false;
  
  // Clean up old jobs and immediately check for the next one.
  await cleanupQueueFx();
  setImmediate(processQueue);
}

// =========================================================================
// FINAL FIX: Kick-start the queue processor when the application launches.
// This will pick up any jobs that were left over from a previous session.
// =========================================================================
console.log('[QueueManager] Initializing queue processor on startup...');
setImmediate(processQueue);
