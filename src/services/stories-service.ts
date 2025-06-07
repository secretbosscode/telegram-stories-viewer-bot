// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample, combine } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
import { sendStoriesFx, SendStoriesFxParams } from 'controllers/send-stories';

// --- Core Imports from Config & Lib ---
import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { bot } from 'index';
import { saveUser } from 'repositories/user-repository';

// --- Database Effects Imports ---
import {
  enqueueDownloadFx,
  getNextQueueItemFx,
  markProcessingFx,
  markDoneFx,
  markErrorFx,
  wasRecentlyDownloadedFx,
  isDuplicatePendingFx
} from 'db/effects';

// --- Type Imports ---
import { UserInfo, DownloadQueueItem } from 'types'; // Assuming types are defined here

// =========================================================================
// STORES & EVENTS
// =========================================================================

/** The task currently being processed by the application. null if idle. */
export const $currentTask = createStore<UserInfo | null>(null);

/** A simple boolean flag derived from $currentTask to easily check if the service is busy. */
export const $isTaskRunning = $currentTask.map(task => task !== null);

/** The raw event triggered by an incoming user request. */
export const newTaskReceived = createEvent<UserInfo>();

/** Internal event to signal that the system should check for the next available task from the DB. */
export const checkTasks = createEvent<void>();

/** Internal event to signal that a task has finished (either successfully or failed) and cleanup can occur. */
const taskDone = createEvent<void>();

/** Internal event to track temporary messages for later cleanup. */
export const tempMessageSent = createEvent<number>();

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

/**
 * This effect is the entry point for a new task. It performs asynchronous validation
 * against the database (cooldown, duplicates) before adding the task to the queue.
 */
export const validateAndEnqueueTaskFx = createEffect(async (newTask: UserInfo) => {
  const is_admin = newTask.chatId === BOT_ADMIN_ID.toString();
  const is_premium = !!newTask.isPremium;
  const cooldownHours = is_admin ? 0 : (is_premium ? 2 : 12);

  // 1. Check cooldown unless the user is an admin
  if (cooldownHours > 0 && await wasRecentlyDownloadedFx({ telegram_id: newTask.chatId, target_username: newTask.link, hours: cooldownHours })) {
    await bot.telegram.sendMessage(newTask.chatId, `⏳ As a${is_premium ? " premium" : ""} user, you can only request downloads for "${newTask.link}" once every ${cooldownHours} hours. Please try again later.`);
    throw new Error('Cooldown'); // Throw a specific error to be caught later
  }

  // 2. Check for duplicate pending/processing tasks
  if (await isDuplicatePendingFx({ telegram_id: newTask.chatId, target_username: newTask.link })) {
    await bot.telegram.sendMessage(newTask.chatId, `⚠️ This download is already in the queue for you. Please wait for it to finish.`);
    throw new Error('Duplicate');
  }

  // 3. Enqueue to the database if all checks pass
  await enqueueDownloadFx({ telegram_id: newTask.chatId, target_username: newTask.link, task_details: newTask });
  await bot.telegram.sendMessage(newTask.chatId, `✅ Download for ${newTask.link} has been added to the queue!`);
  
  return newTask;
});

// Any new task received from a user is immediately sent for validation.
sample({
  clock: newTaskReceived,
  target: validateAndEnqueueTaskFx,
});

// If a task is successfully validated and enqueued, trigger a check for the next available task.
sample({
  clock: validateAndEnqueueTaskFx.doneData,
  target: checkTasks,
});

// Handle validation failures (e.g., cooldown or duplicate found).
sample({
  clock: validateAndEnqueueTaskFx.fail,
  // Only handle unexpected errors. Cooldown/Duplicate errors are handled above by sending a message.
  filter: (payload) => payload.error.message !== 'Cooldown' && payload.error.message !== 'Duplicate',
  fn: (payload) => {
    const { params, error } = payload;
    console.error(`[StoriesService] Task validation/enqueue failed for ${params.link}:`, error);
    return { task: params, message: `Failed to queue task: ${error.message || 'Unknown error'}` };
  },
  target: sendErrorMessageFx,
});


// --- 2. Processing the Next Task from the Queue ---

// When `checkTasks` is called, if no other task is currently running, attempt to get the next item from the DB.
sample({
  clock: checkTasks,
  source: $isTaskRunning,
  filter: (isRunning) => !isRunning, // Only proceed if NOT currently running a task
  target: getNextQueueItemFx,
});

// When a job is successfully fetched from the database queue...
sample({
  clock: getNextQueueItemFx.doneData,
  filter: (job): job is DownloadQueueItem => job !== null, // ...and it's not null (i.e., the queue wasn't empty)
  fn: (job) => {
    // 1. Transform the database item into the UserInfo shape the application uses.
    const userTask: UserInfo = {
      chatId: job.telegram_id,
      link: job.target_username,
      ...job.task_details, // Spread the rest of the task details
      instanceId: job.id, // IMPORTANT: Carry the DB job ID forward for later updates.
    };
    return userTask;
  },
  // 2. Set it as the current task and mark it as "processing" in the database.
  target: [$currentTask, markProcessingFx.prepend((task: UserInfo) => task.instanceId!)],
});

// When $currentTask receives a new task, it means processing has officially started.
// Trigger the appropriate story-fetching effect.
const taskStarted = sample({ clock: $currentTask, filter: (task): task is UserInfo => task !== null });
sample({ clock: taskStarted, filter: (task) => task.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (task) => task.linkType === 'link', target: getParticularStoryFx });


// --- 3. Handling Task Results ---

// This unified sample handles a failed fetch from either get*StoriesFx effect.
sample({
  clock: [getAllStoriesFx.fail, getParticularStoryFx.fail],
  source: $currentTask,
  filter: (task): task is UserInfo => task !== null,
  fn: (task, error: Error) => { // error comes from the clock
    console.error(`[StoriesService] Story fetch failed for task ${task.link}:`, error);
    // Mark the job as failed in the database
    if (task.instanceId) {
      markErrorFx({ jobId: task.instanceId, error: error?.message || 'Unknown fetch error' });
    }
    // Send an error message to the user
    return { task, message: 'Sorry, there was an error fetching the stories. Please try again later.' };
  },
  target: [sendErrorMessageFx, taskDone], // Send message, then mark task as done internally
});

// This unified sample handles a successful fetch from either get*StoriesFx effect.
sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask,
  filter: (task, result): result is object => task !== null && typeof result === 'object' && result !== null,
  fn: (task, fetchedData): SendStoriesFxParams => {
    // Assert task is not null because the filter guarantees it.
    // Transform the raw data into the format expected by sendStoriesFx.
    return { task: task!, ...fetchedData }; 
  },
  target: sendStoriesFx, // Trigger the effect that sends the stories to the user.
});


// --- 4. Finalizing the Task ---

// When stories are successfully sent to the user...
sample({
  clock: sendStoriesFx.done,
  fn: ({ params }) => params.task.instanceId, // Get the job ID from the completed task
  filter: (jobId): jobId is string => !!jobId, // Ensure we have a job ID
  target: [markDoneFx, taskDone], // ...mark it as done in the DB and trigger internal task cleanup.
});

// When sending stories to the user fails...
sample({
  clock: sendStoriesFx.fail,
  fn: ({ params, error }) => {
    console.error(`[StoriesService] sendStoriesFx.fail for task:`, params.task.link, 'Error:', error);
    if (params.task.instanceId) {
      markErrorFx({ jobId: params.task.instanceId, error: error?.message || 'Unknown sending error' });
    }
    return; // We don't need to pass anything to the target
  },
  target: taskDone, // ...still trigger internal task cleanup.
});

// When any task is finished, immediately check if there's another one to process.
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

// When a task is marked done, trigger the cleanup of its temporary messages.
sample({
  clock: taskDone,
  source: $currentTask,
  filter: (task): task is UserInfo => task !== null,
  target: cleanupTempMessagesFx,
});

// When a task is done, clear the current task from the state.
$currentTask.on(taskDone, () => null);

// Logic to add a temporary message ID to the current task's state.
$currentTask.on(tempMessageSent, (task, msgId) => {
  if (!task) return null;
  return { ...task, tempMessages: [...(task.tempMessages ?? []), msgId] };
});

// Logic to clear the temporary message list from the task state after they've been deleted.
$currentTask.on(cleanupTempMessagesFx.done, (task) => {
  if (!task) return null;
  return { ...task, tempMessages: [] };
});
