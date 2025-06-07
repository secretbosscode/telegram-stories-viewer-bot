// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample, combine } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessage as sendErrorMessageFn } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';
import { SendStoriesFxParams, UserInfo, DownloadQueueItem } from 'types';

import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { saveUser } from 'repositories/user-repository';
import { User } from 'telegraf/typings/core/types/typegram';

import {
  enqueueDownloadFx,
  getNextQueueItemFx,
  markProcessingFx,
  markDoneFx,
  markErrorFx,
  wasRecentlyDownloadedFx,
  isDuplicatePendingFx
} from 'db/effects';


// =========================================================================
// STORES & EVENTS
// =========================================================================

export const $currentTask = createStore<UserInfo | null>(null);
export const $isTaskRunning = $currentTask.map(task => task !== null);
export const newTaskReceived = createEvent<UserInfo>();
export const checkTasks = createEvent<void>();
export const tempMessageSent = createEvent<number>();
const taskDone = createEvent<void>();
const taskStarted = createEvent<UserInfo>();
const sendErrorMessageFx = createEffect(sendErrorMessageFn);

// =========================================================================
// LOGIC AND FLOW
// =========================================================================

export const saveUserFx = createEffect(saveUser);
sample({
  clock: newTaskReceived.filter({ fn: (task): task is UserInfo & { user: User } => !!task.user }),
  fn: (task) => task.user,
  target: saveUserFx,
});


// --- 1. Task Validation and Enqueueing ---
export const validateAndEnqueueTaskFx = createEffect(async (newTask: UserInfo) => {
    const is_admin = newTask.chatId === BOT_ADMIN_ID.toString();
    const is_premium = !!newTask.isPremium;
    const cooldownHours = is_admin ? 0 : (is_premium ? 2 : 12);
    if (cooldownHours > 0 && await wasRecentlyDownloadedFx({ telegram_id: newTask.chatId, target_username: newTask.link, hours: cooldownHours })) {
        throw new Error('Cooldown');
    }
    if (await isDuplicatePendingFx({ telegram_id: newTask.chatId, target_username: newTask.link })) {
        throw new Error('Duplicate');
    }
    await enqueueDownloadFx({ telegram_id: newTask.chatId, target_username: newTask.link });
    await bot.telegram.sendMessage(newTask.chatId, `✅ Download for ${newTask.link} has been added to the queue!`);
    return newTask;
});

sample({ clock: newTaskReceived, target: validateAndEnqueueTaskFx });
sample({ clock: validateAndEnqueueTaskFx.doneData, target: checkTasks });

validateAndEnqueueTaskFx.fail.watch(({ params, error }) => {
    let message = `Failed to queue task: ${error.message || 'Unknown error'}`;
    if (error.message === 'Cooldown') {
        const is_premium = !!params.isPremium;
        const cooldownHours = is_premium ? 2 : 12;
        message = `⏳ You can only request downloads for "${params.link}" once every ${cooldownHours} hours.`;
    }
    if (error.message === 'Duplicate') {
        message = `⚠️ This download is already in the queue.`;
    }
    sendErrorMessageFn({ task: params, message });
});

// --- 2. Processing the Next Task from the Queue ---
sample({
  clock: checkTasks,
  source: $isTaskRunning,
  filter: (isRunning) => !isRunning,
  target: getNextQueueItemFx,
});

const taskReadyToStart = sample({
  clock: getNextQueueItemFx.doneData,
  filter: (job): job is DownloadQueueItem => job !== null,
});

sample({
  clock: taskReadyToStart,
  fn: (job: DownloadQueueItem): UserInfo => ({
    ...job.task,
    chatId: job.chatId,
    instanceId: job.id,
  }),
  target: taskStarted,
});

sample({ clock: taskReadyToStart, fn: (job: DownloadQueueItem) => job.id, target: markProcessingFx });
sample({ clock: taskStarted, target: $currentTask });
sample({ clock: taskStarted, filter: (task) => task.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (task) => task.linkType === 'link', target: getParticularStoryFx });


// --- 3. Handling Task Results ---
getAllStoriesFx.fail.watch(({ params, error }) => {
    if (params.instanceId) {
      markErrorFx({ jobId: params.instanceId, message: error.message || 'Unknown fetch error' });
    }
    sendErrorMessageFx({ task: params, message: 'Sorry, an error occurred while fetching stories.' });
    taskDone();
});

getParticularStoryFx.fail.watch(({ params, error }) => {
    if (params.instanceId) {
      markErrorFx({ jobId: params.instanceId, message: error.message || 'Unknown fetch error' });
    }
    sendErrorMessageFx({ task: params, message: 'Sorry, an error occurred while fetching the story.' });
    taskDone();
});

// =========================================================================
// FINAL FIX: This sample block's filter signature was corrected.
// =========================================================================
sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask,
  // The filter receives both `source` and `clock` data. This signature is now correct.
  filter: (task, result): task is UserInfo => {
      return task !== null && typeof result === 'object' && result !== null;
  },
  fn: (task, resultData) => ({
    task: task, // `task` is now guaranteed to be UserInfo, not null
    ...(resultData as object),
  }),
  target: sendStoriesFx,
});


// --- 4. Finalizing the Task ---
sendStoriesFx.done.watch(({ params }) => {
    if (params.task.instanceId) {
        markDoneFx(params.task.instanceId);
    }
    taskDone();
});

sendStoriesFx.fail.watch(({ params, error }) => {
    console.error(`[StoriesService] sendStoriesFx.fail for task:`, params.task.link, 'Error:', error);
    if (params.task.instanceId) {
        markErrorFx({ jobId: params.task.instanceId, message: error.message || 'Unknown sending error' });
    }
    taskDone();
});

sample({ clock: taskDone, target: checkTasks });


// --- 5. State Cleanup and Utility Effects ---
export const cleanupTempMessagesFx = createEffect(async (task: UserInfo) => {
    if (task.tempMessages && task.tempMessages.length > 0) {
      await Promise.allSettled(
        task.tempMessages.map(id => bot.telegram.deleteMessage(task.chatId, id).catch(() => null))
      );
    }
});
  
sample({
    clock: taskDone,
    source: $currentTask,
    filter: (task): task is UserInfo => task !== null,
    target: cleanupTempMessagesFx,
});

$currentTask.on(taskDone, () => null);

$currentTask.on(tempMessageSent, (task, msgId) => {
    if (!task) return null;
    return { ...task, tempMessages: [...(task.tempMessages ?? []), msgId] };
});

$currentTask.on(cleanupTempMessagesFx.done, (task) => {
    if (!task) return null;
    return { ...task, tempMessages: [] };
});
