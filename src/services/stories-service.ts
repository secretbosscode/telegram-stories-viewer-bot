// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample, combine } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessage as sendErrorMessageFn } from 'controllers/send-message';
import { sendStoriesFx, SendStoriesFxParams } from 'controllers/send-stories';

import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
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

import { UserInfo, DownloadQueueItem } from 'types';

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

// FIX: Wrap the imported async function in an Effect to make it a valid Effector target.
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

    // FIX: Call the enqueue effect with the correct parameters, as defined in your `db/effects.ts`.
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

sample({
  clock: validateAndEnqueueTaskFx.fail,
  fn: (payload: { params: UserInfo; error: Error }) => {
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
    return { task: params, message };
  },
  target: sendErrorMessageFx,
});


// --- 2. Processing the Next Task from the Queue ---

sample({
  clock: checkTasks,
  source: $isTaskRunning,
  filter: (isRunning) => !isRunning,
  target: getNextQueueItemFx,
});

// When a job is fetched, trigger the `taskStarted` event with the transformed data.
sample({
  clock: getNextQueueItemFx.doneData,
  filter: (job): job is DownloadQueueItem => job !== null,
  fn: (job: DownloadQueueItem): UserInfo => {
    // FIX: Correctly transform the DB object into the internal UserInfo shape.
    return {
      ...job.task, // Spread the nested task object
      chatId: job.chatId, // Overwrite chatId from the parent DB record
      instanceId: job.id, // Carry the DB job ID forward as instanceId
    };
  },
  target: taskStarted,
});

// When a task starts, update the current task store and mark it as processing in the DB.
sample({
  clock: taskStarted,
  target: [$currentTask, markProcessingFx.prepend((task: UserInfo) => task.instanceId!)],
});

// Trigger the appropriate story-fetching effect.
sample({ clock: taskStarted, filter: (task) => task.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (task) => task.linkType === 'link', target: getParticularStoryFx });


// --- 3. Handling Task Results ---

sample({
  clock: [getAllStoriesFx.fail, getParticularStoryFx.fail],
  source: $currentTask,
  filter: (task): task is UserInfo => task !== null,
  fn: (task, error: Error) => {
    console.error(`[StoriesService] Story fetch failed for task ${task.link}:`, error);
    if (task.instanceId) {
        markErrorFx(task.instanceId, error?.message || 'Unknown fetch error');
    }
    return { task, message: 'Sorry, there was an error fetching the stories. Please try again later.' };
  },
  target: [sendErrorMessageFx, taskDone],
});

sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask,
  filter: (task, result): result is object => task !== null && typeof result === 'object' && result !== null,
  fn: (task, fetchedData): SendStoriesFxParams => ({
    task: task!,
    ...(fetchedData as any),
  }),
  target: sendStoriesFx,
});


// --- 4. Finalizing the Task ---

sample({
  clock: sendStoriesFx.done,
  fn: ({ params }) => params.task.instanceId,
  filter: (jobId): jobId is string => !!jobId,
  target: [markDoneFx, taskDone],
});

sample({
  clock: sendStoriesFx.fail,
  fn: ({ params, error }) => {
    console.error(`[StoriesService] sendStoriesFx.fail for task:`, params.task.link, 'Error:', error);
    if (params.task.instanceId) {
      // FIX: Call markErrorFx with two separate string arguments as defined in your effects file.
      markErrorFx(params.task.instanceId, error?.message || 'Unknown sending error');
    }
  },
  target: taskDone,
});

// After any task finishes, check for the next one.
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
