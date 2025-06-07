// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample, combine } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessage as sendErrorMessageFn } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';

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

import { UserInfo, DownloadQueueItem, SendStoriesFxParams } from 'types';

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
  clock: newTaskReceived,
  filter: (task): task is UserInfo & { user: User } => !!task.user,
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
    
    // Your db/effects.ts expects only these two params for this effect
    await enqueueDownloadFx({ telegram_id: newTask.chatId, target_username: newTask.link });
    
    await bot.telegram.sendMessage(newTask.chatId, `✅ Download for ${newTask.link} has been added to the queue!`);
    return newTask;
});

sample({
  clock: newTaskReceived,
  target: validateAndEnqueueTaskFx,
});

sample({
  clock: validateAndEnqueueTaskFx.doneData,
  target: checkTasks,
});

validateAndEnqueueTaskFx.fail.watch((payload) => {
    const { params, error } = payload;
    let message = `Failed to queue task: ${error.message || 'Unknown error'}`;
    if (error.message === 'Cooldown') {
        const is_premium = !!params.isPremium;
        const cooldownHours = is_premium ? 2 : 12;
        message = `⏳ You can only request downloads for "${params.link}" once every ${cooldownHours} hours. Please try again later.`;
    }
    if (error.message === 'Duplicate') {
        message = `⚠️ This download is already in the queue for you. Please wait for it to finish.`;
    }
    // We call the raw function here, which is simpler for error handling
    sendErrorMessageFn({ task: params, message });
});


// --- 2. Processing the Next Task from the Queue ---

sample({
  clock: checkTasks,
  source: $isTaskRunning,
  filter: (isRunning) => !isRunning,
  target: getNextQueueItemFx,
});

sample({
  clock: getNextQueueItemFx.doneData,
  filter: (job): job is DownloadQueueItem => job !== null,
  target: taskStarted.prepend((job: DownloadQueueItem): UserInfo => ({
    ...job.task,
    chatId: job.chatId, // Use chatId from the parent record
    instanceId: job.id,
  })),
});

sample({
  clock: taskStarted,
  target: [$currentTask, markProcessingFx.prepend((task: UserInfo) => task.instanceId!)],
});

sample({ clock: taskStarted, filter: (task) => task.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (task) => task.linkType === 'link', target: getParticularStoryFx });


// --- 3. Handling Task Results ---

// Using .fail.watch is much simpler and avoids complex `sample` type issues
getAllStoriesFx.fail.watch(({ params, error }) => {
    console.error(`[StoriesService] Story fetch failed for task ${params.link}:`, error);
    if (params.instanceId) {
        markErrorFx(params.instanceId, error.message || 'Unknown fetch error');
    }
    sendErrorMessageFx({ task: params, message: 'Sorry, there was an error fetching the stories.' });
    taskDone();
});

getParticularStoryFx.fail.watch(({ params, error }) => {
    console.error(`[StoriesService] Story fetch failed for task ${params.link}:`, error);
    if (params.instanceId) {
        markErrorFx(params.instanceId, error.message || 'Unknown fetch error');
    }
    sendErrorMessageFx({ task: params, message: 'Sorry, there was an error fetching the stories.' });
    taskDone();
});

// This unified sample handles a successful fetch from either get*StoriesFx effect.
sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask,
  filter: (task, result): task is UserInfo => task !== null && typeof result === 'object' && result !== null,
  fn: (task, fetchedData): SendStoriesFxParams => ({
    task: task,
    ...(fetchedData as any), // Use `as any` to handle the complex union type from the clock
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
        markErrorFx(params.task.instanceId, error.message || 'Unknown sending error');
    }
    taskDone();
});

sample({
  clock: taskDone,
  target: checkTasks,
});


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
