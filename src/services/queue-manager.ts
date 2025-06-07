// src/services/queue-manager.ts

// =========================================================================
// FINAL FIX: Importing from `db/effects` to use the Effector wrappers.
// =========================================================================
import { createEffect, createEvent, createStore, sample } from 'effector';
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

const COOLDOWN_HOURS = {
  free: 12,
  premium: 2,
  admin: 0,
};

function getCooldownHours({ isPremium, isAdmin }: { isPremium?: boolean; isAdmin?: boolean }) {
  if (isAdmin) return COOLDOWN_HOURS.admin;
  if (isPremium) return COOLDOWN_HOURS.premium;
  return COOLDOWN_HOURS.free;
}

export async function handleNewTask(user: UserInfo) {
  const telegram_id = user.chatId;
  const target_username = user.link;
  const is_admin = telegram_id === BOT_ADMIN_ID.toString();
  const is_premium = !!user.isPremium;
  const cooldown = getCooldownHours({ isPremium: is_premium, isAdmin: is_admin });

  try {
    if (await wasRecentlyDownloadedFx({ telegram_id, target_username, hours: cooldown })) {
        await bot.telegram.sendMessage(telegram_id, `⏳ You can request stories for "${target_username}" once every ${cooldown} hours.`);
        return;
    }

    if (await isDuplicatePendingFx({ telegram_id, target_username })) {
        await bot.telegram.sendMessage(telegram_id, `⚠️ This download is already in the queue. Please wait.`);
        return;
    }

    // FIX: Calling the effect with the correct single object payload.
    await enqueueDownloadFx({ telegram_id, target_username, task_details: user });
    await bot.telegram.sendMessage(telegram_id, `✅ Your request for ${target_username} has been queued!`);
    
    setImmediate(processQueue);
  } catch(e: any) {
    console.error('[handleNewTask] Error during task validation/enqueueing:', e);
    await bot.telegram.sendMessage(telegram_id, `❌ Sorry, an error occurred while queueing your request.`);
  }
}

let isProcessing = false;

export async function processQueue() {
  if (isProcessing) return;

  const job: DownloadQueueItem | null = await getNextQueueItemFx();
  if (!job) {
    return;
  }

  isProcessing = true;
  await markProcessingFx(job.id);
  
  const currentTask: UserInfo = { ...job.task, chatId: job.chatId, instanceId: job.id };

  try {
    console.log(`[QueueManager] Starting processing for ${currentTask.link}`);
    
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

  } catch (err: any) {
    console.error(`[QueueManager] Error processing job ${job.id} for ${currentTask.link}:`, err);
    // FIX: Calling markErrorFx with the single object payload it expects.
    await markErrorFx({ jobId: job.id, message: err?.message || 'Unknown processing error' });
    await bot.telegram.sendMessage(job.chatId, `❌ Your download for ${currentTask.link} failed. Reason: ${err?.message || 'Unknown error'}`);
  }

  isProcessing = false;
  
  await cleanupQueueFx();
  
  setImmediate(processQueue);
}

console.log('[QueueManager] Initializing queue processor...');
setImmediate(processQueue);
