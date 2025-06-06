// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample, combine } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message'; // Correctly imports sendErrorMessageFx (the Effect)
import { sendStoriesFx } from 'controllers/send-stories';

// --- Core Imports from Config & Lib ---
import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { getRandomArrayItem } from 'lib';
import { bot } from 'index';
import { saveUser } from 'repositories/user-repository';

// --- Database Effects Imports ---
// These are the Effector effects that interact with your DB utility functions.
// They are defined in src/db/effects.ts.
// Confirmed: markDoneFx expects string jobId, markErrorFx expects string jobId, string error.
import {
  enqueueDownloadFx,
  getNextQueueItemFx,
  markProcessingFx,
  markDoneFx,
  markErrorFx,
  cleanupQueueFx,
  wasRecentlyDownloadedFx,
  isDuplicatePendingFx
} from 'db/effects';

// Import necessary types from your central types.ts file
import { UserInfo, SendStoriesFxParams, DownloadQueueItem } from 'types';

// =========================================================================
// STORES & EVENTS (These are DEFINED and EXPORTED from THIS file - the orchestrator)
// =========================================================================

export const $currentTask = createStore<UserInfo | null>(null);
export const clearTimeoutEvent = createEvent<number>();
export const $taskTimeout = createStore(isDevEnv ? 20000 : 240000);

// These are the core events. They are DEFINED here.
export const newTaskReceived = createEvent<UserInfo>();
export const taskInitiated = createEvent<void>();
export const taskStarted = createEvent<UserInfo>();
export const tempMessageSent = createEvent<number>();
export const taskDone = createEvent<void>();
export const checkTasks = createEvent<void>();
export const cleanUpTempMessagesFired = createEvent();

// =========================================================================
// LOGIC AND FLOW
// =========================================================================

// Timeout logic for tasks
const timeoutList = isDevEnv ? [10000, 15000, 20000] : [240000, 300000, 360000];
export const clearTimeoutWithDelayFx = createEffect((currentTimeout: number) => {
  const nextTimeout = getRandomArrayItem(timeoutList, currentTimeout);
  setTimeout(() => clearTimeoutEvent(nextTimeout), currentTimeout);
});

const MAX_WAIT_TIME = 7;

export const checkTaskForRestart = createEffect(async (task: UserInfo | null) => {
  if (task) {
    const minsFromStart = Math.floor((Date.now() - task.initTime) / 60000);
    if (minsFromStart >= MAX_WAIT_TIME) {
      const isPrivileged = task.chatId === BOT_ADMIN_ID.toString() || task.isPremium === true;
      if (isPrivileged) {
        console.warn(`[StoriesService] Privileged task for ${task.link} (User: ${task.chatId}) running for ${minsFromStart} mins.`);
        try {
          await bot.telegram.sendMessage(task.chatId, `🔔 Your long task for "<span class="math-inline">\{task\.link\}" is still running \(</span>{minsFromStart} mins).`).catch(() => {});
        } catch (e) { /* Error sending notification */ }
      } else {
        console.error('[StoriesService] Non-privileged task took too long, exiting:', JSON.stringify(task));
        await bot.telegram.sendMessage(
          BOT_ADMIN_ID,
          "❌ Bot took too long for a non-privileged task and was shut down:\n\n" + JSON.stringify(task, null, 2)
        );
        process.exit(1);
      }
    }
  }
});

export const sendWaitMessageFx = createEffect(async (params: {
  multipleRequests: boolean;
  taskStartTime: Date | null;
  taskTimeout: number;
  queueLength: number;
  newTask: UserInfo;
}) => {
  let estimatedWaitMs = 0;
  const approximatedQueueLength = 0; // This is a placeholder; real queue depth needs a DB query
  if (params.taskStartTime) {
    const elapsed = Date.now() - params.taskStartTime.getTime();
    estimatedWaitMs = Math.max(params.taskTimeout - elapsed, 0) + (approximatedQueueLength * params.taskTimeout);
  }
  const estimatedWaitSec = Math.ceil(estimatedWaitMs / 1000);
  const waitMsg = estimatedWaitSec > 0 ? `⏳ Please wait: Estimated wait time is ${estimatedWaitSec} seconds before your request starts.` : '⏳ Please wait: Your request will start soon.';
  await bot.telegram.sendMessage(
    params.newTask.chatId,
    waitMsg
  );
});

export const cleanupTempMessagesFx = createEffect(async (task: UserInfo) => {
  if (task.tempMessages && task.tempMessages.length > 0) {
    await Promise.allSettled(
      task.tempMessages.map(id => bot.telegram.deleteMessage(task.chatId, id).catch(() => null))
    );
  }
});

export const saveUserFx = createEffect(saveUser);

// --- Task Queue Management (FULLY INTEGRATED WITH DB) ---

// New: Effect to perform async validation (cooldown, duplicate) and enqueue to DB
export const validateAndEnqueueTaskFx = createEffect(async (newTask: UserInfo) => {
    const is_admin = newTask.chatId === BOT_ADMIN_ID.toString();
    const is_premium = !!newTask.isPremium;
    let cooldownHours = is_premium ? 2 : 12; // Free user default
    if (is_admin) cooldownHours = 0;

    const telegram_id = newTask.chatId;
    const target_username = newTask.link;

    // 1. Check cooldown via DB
    if (!is_admin && await wasRecentlyDownloadedFx({ telegram_id, target_username, hours: cooldownHours })) {
        await bot.telegram.sendMessage(
            telegram_id,
            `⏳ As a${is_premium ? " premium" : ""} user, you can only request downloads for "${target_username}" once every ${cooldownHours} hours. Please wait and try again later.`
        );
        throw new Error('Cooldown'); // Throw to stop further processing
    }

    // 2. Check for duplicate pending/processing tasks via DB
    if (await isDuplicatePendingFx({ telegram_id, target_username })) {
        await bot.telegram.sendMessage(
            telegram_id,
            `⚠️ This download is already queued for you. Please wait for it to finish.`
        );
        throw new Error('Duplicate'); // Throw to stop further processing
    }

    // 3. Enqueue if checks pass
    await enqueueDownloadFx({ telegram_id: newTask.chatId, target_username: newTask.link });
    await bot.telegram.sendMessage(newTask.chatId, `✅ Download for ${newTask.link} queued!`);

    // 4. Save user data
    if (newTask.user) {
        saveUserFx(newTask.user);
    }

    return newTask; // Return the task if successful
});

// Handle new task received: validate and enqueue (if successful)
sample({
  clock: newTaskReceived,
  target: validateAndEnqueueTaskFx, // Direct target to the validation effect
});

// On successful enqueue, trigger checkTasks (which will pick from DB queue)
sample({
  clock: validateAndEnqueueTaskFx.doneData,
  target: checkTasks,
});

// Handle failures from validation (cooldown/duplicate messages already sent by validateAndEnqueueTaskFx)
validateAndEnqueueTaskFx.fail.watch(({ params, error }: { params: UserInfo, error: Error }) => {
    if (error.message !== 'Cooldown' && error.message !== 'Duplicate') {
        console.error(`[StoriesService] Task validation/enqueue failed for ${params.link}:`, error
