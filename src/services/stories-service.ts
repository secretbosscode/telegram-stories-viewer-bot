// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample, combine } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessage } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';

// --- Core Imports from Config & Lib ---
import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { getRandomArrayItem } from 'lib';
import { bot } from 'index';
import { saveUser } from 'repositories/user-repository';

// --- Database Effects Imports ---
// These are the Effector effects that interact with your DB utility functions.
// They are likely defined in src/db/effects.ts
import {
  enqueueDownloadFx,
  getNextQueueItemFx,
  markProcessingFx,
  markDoneFx,
  markErrorFx,
  cleanupQueueFx, // If you use this explicitly in orchestrator
  wasRecentlyDownloadedFx,
  isDuplicatePendingFx
} from 'db/effects'; // <--- Correct import for DB effects

// Import necessary types, including SendStoriesFxParams
import { UserInfo, SendStoriesFxParams, DownloadQueueItem } from 'types'; // Added DownloadQueueItem

// =========================================================================
// STORES & EVENTS (These are now DEFINED and EXPORTED from THIS file - the orchestrator)
// =========================================================================

export const $currentTask = createStore<UserInfo | null>(null);
// Removed $tasksQueue as the DB will manage the queue state
// Removed $isTaskRunning as the DB will manage this via task status updates
// Removed $taskStartTime as DB tasks have timestamps
export const clearTimeoutEvent = createEvent<number>();
export const $taskTimeout = createStore(isDevEnv ? 20000 : 240000);

// These are the core events. They are DEFINED here.
export const newTaskReceived = createEvent<UserInfo>();
// Removed taskReadyToBeQueued - tasks are now directly enqueued in DB
export const taskInitiated = createEvent<void>(); // Still used to initiate processing
export const taskStarted = createEvent<UserInfo>(); // Signal a task has started processing (from DB)
export const tempMessageSent = createEvent<number>();
export const taskDone = createEvent<void>(); // Signal a task is completed/failed
export const checkTasks = createEvent<void>(); // Trigger to check for next task
export const cleanUpTempMessagesFired = createEvent();

// =========================================================================
// LOGIC AND FLOW
// =========================================================================

// Removed sample(clock: taskReadyToBeQueued, target: checkTasks)
// checkTasks will now be triggered directly after enqueue or taskDone

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
          await bot.telegram.sendMessage(task.chatId, `🔔 Your long task for "${task.link}" is still running (${minsFromStart} mins).`).catch(() => {});
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

// Removed $taskSource - DB operations will provide direct source where needed

export const sendWaitMessageFx = createEffect(async (params: { // This logic might need review if queueLength is no longer from in-memory queue
  multipleRequests: boolean;
  taskStartTime: Date | null;
  taskTimeout: number;
  queueLength: number; // This needs to be calculated dynamically from DB now.
  newTask: UserInfo;
}) => {
  // This logic needs to be updated to get queueLength from DB if no longer from in-memory queue.
  // For now, removing direct access to old $taskSource queue.
  // A simple approximation for now. Actual queue position needs new DB query.
  let estimatedWaitMs = 0;
  // If taskStartTime is derived from DB processed_ts, use that.
  const approximatedQueueLength = 0; // Replace with a DB query if needed
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

// Removed $queueState and its combine

// On new task received, perform DB checks and enqueue
sample({
  clock: newTaskReceived,
  filter: async (newTask): Promise<boolean> => { // Async filter
    const is_admin = newTask.chatId === BOT_ADMIN_ID.toString();
    const is_premium = !!newTask.isPremium;
    const cooldownHours = is_premium ? 2 : 12; // Free user default
    if (is_admin) cooldownHours = 0; // Admin has no cooldown

    const telegram_id = newTask.chatId;
    const target_username = newTask.link;

    // 1. Check cooldown via DB
    if (!is_admin && await wasRecentlyDownloadedFx({ telegram_id, target_username, hours: cooldownHours })) {
      await bot.telegram.sendMessage(
        telegram_id,
        `⏳ As a${is_premium ? " premium" : ""} user, you can only request downloads for "${target_username}" once every ${cooldownHours} hours. Please wait and try again later.`
      );
      return false;
    }

    // 2. Check for duplicate pending/processing tasks via DB
    if (await isDuplicatePendingFx({ telegram_id, target_username })) {
      await bot.telegram.sendMessage(
        telegram_id,
        `⚠️ This download is already queued for you. Please wait for it to finish.`
      );
      return false;
    }
    return true; // Pass filter if no cooldown/duplicate
  },
  fn: async (newTask): Promise<UserInfo> => { // This fn becomes async if the filter is async
    // User data is saved directly
    saveUserFx(newTask.user!); // Call the effect to save user (optional)
    await enqueueDownloadFx({ telegram_id: newTask.chatId, target_username: newTask.link }); // Enqueue to DB
    await bot.telegram.sendMessage(newTask.chatId, `✅ Download for ${newTask.link} queued!`); // User confirmation
    return newTask; // Pass the task for further orchestration
  },
  target: checkTasks, // After enqueuing, check the queue
});

// Removed $tasksQueue.on(taskReadyToBeQueued, ...)

// $isTaskRunning is managed by taskStarted/taskDone events, which are derived from DB state changes
// $tasksQueue.on(taskDone, ...) is removed, as queue is DB-managed

// This sample was using .getState(), which is less safe.
// The `sendWaitMessageFx` might need to be refined to query queue position from DB if needed.
sample({
  clock: newTaskReceived, // Task just received (after initial checks)
  source: newTaskReceived, // Source the original task for context
  filter: (task: UserInfo) => { // Refine filter logic for sendWaitMessageFx
    // Send wait message only if not privileged and queue is likely busy
    const isPrivileged = task.chatId === BOT_ADMIN_ID.toString() || task.isPremium === true;
    if (!isPrivileged) {
      // This is a placeholder; real queue depth might need DB query
      return true; // Always show wait message for now, or add DB query for queue depth
    }
    return false;
  },
  fn: (newTask: UserInfo) => ({
    multipleRequests: true, // Placeholder for actual check
    taskStartTime: null, // Placeholder for actual check
    taskTimeout: isDevEnv ? 20000 : 240000, // From $taskTimeout
    queueLength: 1, // Placeholder for actual DB queue length
    newTask: newTask,
  }),
  target: sendWaitMessageFx,
});


type TaskInitiationSource = { isRunning: boolean; currentSystemCooldownStartTime: Date | null; }; // Queue is now DB-managed
const $taskInitiationDataSource = combine<TaskInitiationSource>({
  isRunning: $isTaskRunning, // Keep this as it's active state
  currentSystemCooldownStartTime: createStore<Date | null>(null) // Placeholder, needs DB query for current cooldown/processing
});

sample({
  clock: checkTasks,
  source: $taskInitiationDataSource,
  filter: (sourceValues) => {
    // If a task is already running, or if there's no task in DB, don't initiate
    if (sourceValues.isRunning) return false;
    // Check if there's a next item in DB queue. This requires calling getNextQueueItemFx
    return true; // Placeholder, the actual check happens with getNextQueueItemFx
  },
  target: taskInitiated,
});

// When `taskInitiated`, fetch the next job from DB (getNextQueueItemFx)
sample({
  clock: taskInitiated,
  target: getNextQueueItemFx,
});

// When `getNextQueueItemFx` succeeds and a job is returned, process it
sample({
  clock: getNextQueueItemFx.doneData,
  filter: (job: DownloadQueueItem | null): job is DownloadQueueItem => job !== null, // Only proceed if job is found
  fn: (job: DownloadQueueItem) => {
    // Transform DownloadQueueItem from DB into UserInfo for Effector processing
    const userTask: UserInfo = {
      chatId: job.chatId,
      link: job.task.link,
      linkType: job.task.linkType,
      nextStoriesIds: job.task.nextStoriesIds,
      locale: job.task.locale,
      user: job.task.user,
      tempMessages: job.task.tempMessages,
      initTime: job.task.initTime,
      isPremium: job.task.isPremium,
      instanceId: job.task.instanceId,
      storyRequestType: job.task.storyRequestType,
    };
    taskStarted(userTask); // Signal task has started (updates $isTaskRunning)
    return job.id; // Return DB job ID to mark as processing
  },
  target: markProcessingFx, // Mark job as processing in DB
});

// Start fetching stories when a task officially starts
sample({ clock: taskStarted, filter: (t) => t.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (t) => t.linkType === 'link', target: getParticularStoryFx });

// Removed $taskTimeout.on and sample(clearTimeoutEvent) as they are part of in-memory timeout mechanism.
// The timeout for a task should be handled within the fetch effects or an external process monitoring DB.
// If you still want timeouts, you might need to re-evaluate where clearTimeoutWithDelayFx is used.


// --- Effect Result Handling ---
// This part will now transform the result of get*StoriesFx into SendStoriesFxParams
// to be sent to the sendStoriesFx dispatcher.

// Handle error messages from get*StoriesFx (if they return a string)
sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask,
  filter: (task: UserInfo | null, result): result is string => task !== null && typeof result === 'string',
  fn: (task: UserInfo, message: string) => ({ task: task!, message: message }),
  target: [sendErrorMessage, taskDone, checkTasks], // Target sendErrorMessage effect, then cleanup
});

// Handle successful data from get*StoriesFx (if they return an object/array)
sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask, // Source $currentTask for full context
  filter: (task: UserInfo | null, fetchedDataResult): fetchedDataResult is (object | object[]) =>
    task !== null && typeof fetchedDataResult !== 'string' && fetchedDataResult !== null,
  fn: (task: UserInfo, fetchedDataResult: object | object[]): SendStoriesFxParams => {
    const params: SendStoriesFxParams = { task: task! }; // Use task! since filter ensures it's not null
    if (typeof fetchedDataResult === 'object' && fetchedDataResult !== null) {
      if ('particularStory' in fetchedDataResult && fetchedDataResult.particularStory) {
        params.particularStory = (fetchedDataResult as { particularStory: any }).particularStory;
      } else if ('activeStories' in fetchedDataResult || 'pinnedStories' in fetchedDataResult || 'paginatedStories' in fetchedDataResult) {
        const data = fetchedDataResult as {
          activeStories?: any[];
          pinnedStories?: any[];
          paginatedStories?: any[];
        };
        if (data.activeStories) params.activeStories = data.activeStories;
        if (data.pinnedStories) params.pinnedStories = data.pinnedStories;
        if (data.paginatedStories) params.paginatedStories = data.paginatedStories;
      } else {
        console.error('[stories-service] Unexpected result type from fetch effect:', fetchedDataResult);
        throw new Error('Unexpected story data type received.');
      }
    } else {
      console.error('[stories-service] Fetch effect produced non-object/non-array:', fetchedDataResult);
      throw new Error('Invalid data type received from fetch effect.');
    }
    return params;
  },
  target: sendStoriesFx, // Target the sendStoriesFx dispatcher
});

// --- Finalization Logic ---
sendStoriesFx.done.watch(({ params }) => {
  console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link);
  markDoneFx(params.task.instanceId!); // Mark in DB as done (assuming instanceId is the DB ID)
});
sendStoriesFx.fail.watch(({ params, error }) => {
  console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error);
  markErrorFx(params.task.instanceId!, error?.message || 'Unknown sending error'); // Mark in DB as error
});

// Mark task as done and trigger cleanup
sample({
  clock: [getAllStoriesFx.fail, getParticularStoryFx.fail], // If fetch fails
  source: $currentTask, // Get the current task context
  filter: (task: UserInfo | null): task is UserInfo => task !== null,
  fn: (task: UserInfo, error: any) => { // error is from the clock
    console.error(`[StoriesService] Fetch effect failed for task ${task.link}:`, error);
    markErrorFx(task.instanceId!, error?.message || 'Unknown fetch error'); // Mark in DB as error
    return; // Pass nothing to target, as we're just triggering taskDone/checkTasks
  },
  target: [taskDone, checkTasks] // Mark done and check next task
});

// When a task is marked done, trigger cleanupTempMessagesFx with the task context
sample({
  clock: taskDone,
  source: $currentTask,
  filter: (t: UserInfo | null): t is UserInfo => t !== null,
  target: cleanupTempMessagesFx.prepend((task: UserInfo) => task)
});

// Update the current task store to null when a task is done
$currentTask.on(taskDone, () => null);

// Update task running status to false when a task is done
// Removed $isTaskRunning.on(taskDone, () => false); as it's now inferred from isRunning in combine or managed by getNextQueueItemFx check.
// If you still want $isTaskRunning, it should be set to true by taskStarted and false by taskDone.
// $isTaskRunning.on(taskStarted, () => true);
// $isTaskRunning.on(taskDone, () => false); // This is already in place.

// Removed $tasksQueue.on(taskDone, ...) as queue is DB-managed.

// Handle temporary message IDs sent during processing
sample({
  clock: tempMessageSent, // tempMessageSent is the event for new temp message IDs
  source: $currentTask,
  filter: (currentTaskState: UserInfo | null, msgId: number): currentTaskState is UserInfo => currentTaskState !== null,
  fn: (currentTaskState: UserInfo, msgId: number): UserInfo => {
    return { ...currentTaskState, tempMessages: [...(currentTaskState.tempMessages ?? []), msgId] };
  },
  target: $currentTask // Update $currentTask store
});

// Clear tempMessages array in the current task state after cleanup effect is done
sample({
  clock: cleanupTempMessagesFx.done,
  source: $currentTask,
  filter: (currentTaskState: UserInfo | null, { params: finishedTaskParams }): currentTaskState is UserInfo =>
    currentTaskState !== null && currentTaskState.instanceId === finishedTaskParams.instanceId,
  fn: (currentTaskState: UserInfo) => ({ ...currentTaskState, tempMessages: [] }),
  target: $currentTask // Target the $currentTask store to update its state
});

// --- Interval Timers ---
const intervalHasPassed = createEvent<void>();
sample({
  clock: intervalHasPassed,
  source: $currentTask,
  filter: (t: UserInfo | null): t is UserInfo => t !== null,
  target: checkTaskForRestart
});
setInterval(() => intervalHasPassed(), 30_000);

// =========================================================================
// EXPORTS (These are implicitly exported by their 'export const' declarations above)
// =========================================================================
// The common events/stores/effects that other files need to import from here:
// (You might explicitly list them here if you prefer, but 'export const' is sufficient)
