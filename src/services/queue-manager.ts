// src/services/queue-manager.ts

import { createEffect, createEvent, sample, createStore } from 'effector';
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
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendStoriesFx } from 'controllers/send-stories';

// =========================================================================
// State and Events for the Queue Manager
// =========================================================================

// This store will now hold the currently processing job's info.
const $currentJob = createStore<DownloadQueueItem | null>(null);
// The system is "processing" if there is a job in the current state.
const $isProcessing = $currentJob.map(job => job !== null);

// An event to signal that we should check for the next task.
const checkQueue = createEvent();
// An event to signal a job has finished, successfully or not.
const jobFinished = createEvent();

// =========================================================================

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
    
    // Trigger the queue check after successfully adding a task.
    checkQueue();
  } catch(e: any) {
    console.error('[handleNewTask] Error during task validation/enqueueing:', e);
    await bot.telegram.sendMessage(telegram_id, `❌ Sorry, an error occurred while queueing your request.`);
  }
}

// =========================================================================
// The Queue Processing Logic (Now using Effector for robust state)
// =========================================================================

// When checkQueue is called, if we are not already busy, get the next item from the database.
sample({
  clock: checkQueue,
  source: $isProcessing,
  filter: (isProcessing) => !isProcessing,
  target: getNextQueueItemFx,
});

// When a job is successfully fetched from the database...
sample({
  clock: getNextQueueItemFx.doneData,
  filter: (job): job is DownloadQueueItem => job !== null, // ...and it's not empty...
  target: $currentJob, // ...set it as the current job.
});

// When the current job is set, mark it as "in_progress" in the DB.
sample({
  clock: $currentJob.updates,
  filter: (job): job is DownloadQueueItem => job !== null,
  fn: (job) => job.id,
  target: markProcessingFx,
});

// This effect now contains the core work for a single job.
const processJobFx = createEffect(async (job: DownloadQueueItem) => {
    const currentTask: UserInfo = { ...job.task, chatId: job.chatId, instanceId: job.id };
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
});

// When the current job is set, trigger the processing effect.
sample({
  clock: $currentJob.updates,
  filter: (job): job is DownloadQueueItem => job !== null,
  target: processJobFx,
});

// If processing succeeds, mark it done in the DB.
sample({
  clock: processJobFx.done,
  fn: ({ params }) => params.id,
  target: [markDoneFx, jobFinished], // Also trigger jobFinished
});

// If processing fails, mark it with an error in the DB.
processJobFx.fail.watch(({ params, error }) => {
    console.error(`[QueueManager] Error processing job ${params.id} for ${params.task.link}:`, error);
    markError({ jobId: params.id, message: error?.message || 'Unknown processing error' });
    bot.telegram.sendMessage(params.chatId, `❌ Your download for ${params.task.link} failed. Reason: ${error?.message || 'Unknown error'}`);
    jobFinished(); // Also trigger jobFinished
});

// When a job is finished, clear the current job state and check for the next one.
$currentJob.on(jobFinished, () => null);
sample({
  clock: jobFinished,
  target: checkQueue,
});

// Periodically clean up old jobs from the database.
setInterval(() => {
    console.log('[QueueManager] Running periodic cleanup of old queue jobs.');
    cleanupQueue();
}, 1000 * 60 * 60); // Every hour

// Start the queue processor when the bot starts.
console.log('[QueueManager] Initializing queue processor...');
checkQueue();
