// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessage as sendErrorMessageFn } from 'controllers/send-message';
import { sendStoriesFx, SendStoriesFxParams } from 'controllers/send-stories';

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

import { UserInfo, DownloadQueueItem } from 'types';

// =========================================================================
// STORES & EVENTS
// This service no longer holds a queue in memory; the database is the queue.
// These stores and events now ORCHESTRATE the flow based on DB state.
// =========================================================================

/** The task currently being processed by the application. null if idle. */
export const $currentTask = createStore<UserInfo | null>(null);
/** A boolean flag derived from $currentTask to easily check if the service is busy. */
export const $isTaskRunning = $currentTask.map(task => task !== null);

/** The raw event triggered by an incoming user request. */
export const newTaskReceived = createEvent<UserInfo>();
/** Internal event to signal that the system should check for the next available task from the DB. */
export const checkTasks = createEvent<void>();
/** Internal event to track temporary messages for later cleanup. */
export const tempMessageSent = createEvent<number>();

// Internal events for managing the task lifecycle
const taskDone = createEvent<void>();
const taskStarted = createEvent<UserInfo>();

// Wrap the imported async function in an Effect to make it a valid Effector target.
const sendErrorMessageFx = createEffect(sendErrorMessageFn);

// =========================================================================
// LOGIC AND FLOW
// =========================================================================

// --- 1. User and Task Validation ---

export const saveUserFx = createEffect(saveUser);
sample({
  clock: newTaskReceived.filter({ fn: (task): task is UserInfo & { user: User } => !!task.user }),
  fn: (task) => task.user,
  target: saveUserFx,
});

/**
 * This effect is the main entry point. It validates a new task against the database
 * (cooldowns, duplicates) before adding it to the persistent queue.
 */
export const validateAndEnqueueTaskFx = createEffect(async (newTask: UserInfo) => {
    const is_admin = newTask.chatId === BOT_ADMIN_ID.toString();
    const is_premium = !!newTask.isPremium;
    const cooldownHours = is_admin ? 0 : (is_premium ? 2 : 12);

    if (cooldownHours > 0 && await wasRecentlyDownloadedFx({ telegram_id: newTask.chatId, target_username: newTask.link, hours: cooldownHours })) {
        throw new Error('On Cooldown');
    }
    if (await isDuplicatePendingFx({ telegram_id: newTask.chatId, target_username: newTask.link })) {
        throw new Error('Duplicate');
    }
    
    await enqueueDownloadFx({ telegram_id: newTask.chatId, target_username: newTask.link });
    await bot.telegram.sendMessage(newTask.chatId, `✅ Your request for ${newTask.link} has been added to the queue!`);
    
    return newTask; // Pass the task data along on success
});

// Every new task request from a user is sent for validation.
sample({ clock: newTaskReceived, target: validateAndEnqueueTaskFx });

// After a task is successfully added to the DB queue, trigger a check to see if we can start processing.
sample({ clock: validateAndEnqueueTaskFx.doneData, target: checkTasks });

// Handle validation failures by sending a message to the user.
validateAndEnqueueTaskFx.fail.watch(({ params, error }) => {
    let message = `Sorry, your request for "${params.link}" could not be queued.`;
    if (error.message === 'On Cooldown') {
        const is_premium = !!params.isPremium;
        const cooldownHours = is_premium ? 2 : 12;
        message = `⏳ You can request stories for "${params.link}" once every ${cooldownHours} hours. Please wait.`;
    }
    if (error.message === 'Duplicate') {
        message = `⚠️ A request for "${params.link}" is already in the queue. Please be patient.`;
    }
    sendErrorMessageFn({ task: params, message }); // Call the raw function for simplicity
});


// --- 2. Processing the Next Task from the Queue ---

// When `checkTasks` is called, if we are not already busy, get the next item from the database.
sample({
  clock: checkTasks,
  source: $isTaskRunning,
  filter: (isRunning) => !isRunning,
  target: getNextQueueItemFx,
});

// When a job is successfully fetched from the database...
const taskReadyToStart = sample({
  clock: getNextQueueItemFx.doneData,
  filter: (job): job is DownloadQueueItem => job !== null, // ...and it's not empty.
});

// ...transform it into the UserInfo shape and trigger the `taskStarted` event.
sample({
  clock: taskReadyToStart,
  fn: (job: DownloadQueueItem): UserInfo => ({
    ...job.task,
    chatId: job.chatId,
    instanceId: job.id, // Carry the DB ID forward
  }),
  target: taskStarted,
});

// Also mark the job as "in_progress" in the DB to prevent other workers from grabbing it.
sample({
  clock: taskReadyToStart,
  fn: (job: DownloadQueueItem) => job.id,
  target: markProcessingFx,
});

// When a task officially starts, update our current task state and trigger the correct fetcher.
sample({ clock: taskStarted, target: $currentTask });
sample({ clock: taskStarted, filter: (task) => task.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (task) => task.linkType === 'link', target: getParticularStoryFx });


// --- 3. Handling Fetch Results ---

// Using simple, separate .fail.watch() blocks is the most robust way to handle failures.
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

// This is the simplest, most type-safe way to handle the multiple success events.
// We handle each one separately to avoid the complex type errors from before.
sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task): task is UserInfo => task !== null,
  fn: (task, resultData): SendStoriesFxParams => ({ task, ...(resultData as object) }),
  target: sendStoriesFx,
});

sample({
  clock: getParticularStoryFx.doneData,
  source: $currentTask,
  filter: (task): task is UserInfo => task !== null,
  fn: (task, resultData): SendStoriesFxParams => ({ task, ...(resultData as object) }),
  target: sendStoriesFx,
});


// --- 4. Finalizing the Task ---

// When stories are successfully sent, mark the job done in the DB and trigger internal cleanup.
sendStoriesFx.done.watch(({ params }) => {
    if (params.task.instanceId) {
        markDoneFx(params.task.instanceId);
    }
    taskDone();
});

// If sending fails, mark the job with an error in the DB and trigger internal cleanup.
sendStoriesFx.fail.watch(({ params, error }) => {
    console.error(`[StoriesService] sendStoriesFx.fail for task:`, params.task.link, 'Error:', error);
    if (params.task.instanceId) {
        markErrorFx({ jobId: params.task.instanceId, message: error.message || 'Unknown sending error' });
    }
    taskDone();
});

// After ANY task is done, always check for the next one.
sample({ clock: taskDone, target: checkTasks });


// --- 5. State Cleanup ---

export const cleanupTempMessagesFx = createEffect(async (task: UserInfo) => {
    if (task.tempMessages && task.tempMessages.length > 0) {
      await Promise.allSettled(
        task.tempMessages.map(id => bot.telegram.deleteMessage(task.chatId, id).catch(() => null))
      );
    }
});
  
// When a task is done, clean up its temporary messages.
sample({
    clock: taskDone,
    source: $currentTask,
    filter: (task): task is UserInfo => task !== null,
    target: cleanupTempMessagesFx,
});

// Clear the current task from state when it's done.
$currentTask.on(taskDone, () => null);

// Add new temporary message IDs to the current task.
$currentTask.on(tempMessageSent, (task, msgId) => {
    if (!task) return null;
    return { ...task, tempMessages: [...(task.tempMessages ?? []), msgId] };
});

// When cleanup is finished, clear the message IDs from the task state.
$currentTask.on(cleanupTempMessagesFx.done, (task) => {
    if (!task) return null;
    return { ...task, tempMessages: [] };
});
