// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample, combine } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';

// --- Core Imports from Config & Lib (FIXED IMPORTS HERE) ---
import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config'; // <--- ADDED: isDevEnv, BOT_ADMIN_ID
import { getRandomArrayItem } from 'lib'; // <--- ADDED: getRandomArrayItem
import { bot } from 'index'; // <--- ADDED: bot (from main index.ts)
import { saveUser } from 'repositories/user-repository'; // <--- ADDED: saveUser (from repository)

// --- Database Effects Imports ---
// These are the Effector effects that interact with your DB utility functions.
// They are likely defined in src/db/effects.ts
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

export const sendWaitMessageFx = createEffect(async (params: {
  multipleRequests: boolean;
  taskStartTime: Date | null;
  taskTimeout: number;
  queueLength: number;
  newTask: UserInfo;
}) => {
  let estimatedWaitMs = 0;
  const approximatedQueueLength = 0;
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

// On new task received, perform DB checks and enqueue
sample({
  clock: newTaskReceived,
  filter: async (newTask: UserInfo): Promise<boolean> => { // <--- Added type to newTask
    const is_admin = newTask.chatId === BOT_ADMIN_ID.toString();
    const is_premium = !!newTask.isPremium;
    let cooldownHours = is_premium ? 2 : 12;
    if (is_admin) cooldownHours = 0;

    const telegram_id = newTask.chatId;
    const target_username = newTask.link;

    // 1. Check cooldown via DB
    if (!is_admin && await wasRecentlyDownloadedFx({ telegram_id, target_username, hours: cooldownHours })) {
        await bot.telegram.sendMessage(
            telegram_id,
            `⏳ As a${is_premium ? " premium" : ""} user, you can only request downloads for "${target_username}" once every ${cooldownHours} hours. Please wait and try again later.`
        );
        throw new Error('Cooldown');
    }

    // 2. Check for duplicate pending/processing tasks via DB
    if (await isDuplicatePendingFx({ telegram_id, target_username })) {
        await bot.telegram.sendMessage(
            telegram_id,
            `⚠️ This download is already queued for you. Please wait for it to finish.`
        );
        throw new Error('Duplicate');
    }
    return true;
  },
  fn: async (newTask: UserInfo): Promise<UserInfo> => { // <--- Parameter type added here
    saveUserFx(newTask.user!);
    await enqueueDownloadFx({ telegram_id: newTask.chatId, target_username: newTask.link });
    await bot.telegram.sendMessage(newTask.chatId, `✅ Download for ${newTask.link} queued!`);
    return newTask;
  },
  target: checkTasks,
});

// On successful enqueue, trigger checkTasks (which will pick from DB queue)
sample({
  clock: validateAndEnqueueTaskFx.doneData,
  target: checkTasks,
});

// Handle failures from validation (cooldown/duplicate messages already sent by validateAndEnqueueTaskFx)
validateAndEnqueueTaskFx.fail.watch(({ params, error }) => {
    if (error.message !== 'Cooldown' && error.message !== 'Duplicate') {
        console.error(`[StoriesService] Task validation/enqueue failed for ${params.link}:`, error);
        sendErrorMessageFx({ task: params, message: `Failed to queue task: ${error.message}` });
    }
});

// Logic to trigger task initiation (picking from DB queue)
type TaskInitiationSource = { isRunning: boolean; currentSystemCooldownStartTime: Date | null; };
const $taskInitiationDataSource = combine<TaskInitiationSource>({
  isRunning: createStore<boolean>(false),
  currentSystemCooldownStartTime: createStore<Date | null>(null)
});

// `checkTasks` now triggers fetching the next item from the DB
sample({
  clock: checkTasks,
  source: $taskInitiationDataSource,
  filter: async (sourceValues: TaskInitiationSource): Promise<boolean> => { // <--- Added type to sourceValues
    if (sourceValues.isRunning) return false;
    const nextJob = await getNextQueueItemFx();

    if (!nextJob) {
      return false;
    }
    return true;
  },
  target: taskInitiated,
});

// When `taskInitiated`, fetch the next job from DB (getNextQueueItemFx)
sample({
  clock: taskInitiated,
  target: getNextQueueItemFx,
});

// When `getNextQueueItemFx` succeeds and a job is returned, set current task and mark processing in DB
sample({
  clock: getNextQueueItemFx.doneData,
  filter: (job: DownloadQueueItem | null): job is DownloadQueueItem => job !== null,
  fn: (job: DownloadQueueItem) => {
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
    taskStarted(userTask);
    return job.id;
  },
  target: markProcessingFx,
});

// Start fetching stories when a task officially starts
sample({ clock: taskStarted, filter: (t: UserInfo) => t.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (t: UserInfo) => t.linkType === 'link', target: getParticularStoryFx });

// --- Effect Result Handling ---
// This part transforms the result of get*StoriesFx into SendStoriesFxParams
// to be sent to the sendStoriesFx dispatcher.

// Handle error messages from get*StoriesFx (if they return a string)
sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask,
  filter: (task: UserInfo | null, result): result is string => task !== null && typeof result === 'string',
  fn: (task: UserInfo, message: string) => ({ task: task, message: message }), // <--- Removed task!
  target: [sendErrorMessageFx, taskDone, checkTasks],
});

// Handle successful data from get*StoriesFx (if they return an object/array)
sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask,
  filter: (task: UserInfo | null, fetchedDataResult): fetchedDataResult is (object | object[]) =>
    task !== null && typeof fetchedDataResult !== 'string' && fetchedDataResult !== null,
  fn: (task: UserInfo, fetchedDataResult: object | object[]): SendStoriesFxParams => {
    const params: SendStoriesFxParams = { task: task! }; // <--- Use task! here after filter
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
  target: sendStoriesFx,
});

// --- Finalization Logic ---
sendStoriesFx.done.watch(({ params }) => {
  console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link);
  if (params.task.instanceId) { // Check before accessing instanceId
    markDoneFx({jobId: params.task.instanceId}); // <--- markDoneFx expects object
  } else {
    console.warn('[StoriesService] Missing instanceId for task completion:', params.task);
  }
});
sendStoriesFx.fail.watch(({ params, error }) => {
  console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error);
  if (params.task.instanceId) { // Check before accessing instanceId
    markErrorFx({jobId: params.task.instanceId, message: error?.message || 'Unknown sending error'}); // <--- markErrorFx expects object
  } else {
    console.warn('[StoriesService] Missing instanceId for task failure:', params.task);
  }
});

// Mark task as done and trigger cleanup
sample({
  clock: [getAllStoriesFx.fail, getParticularStoryFx.fail],
  source: $currentTask,
  filter: (task: UserInfo | null): task is UserInfo => task !== null,
  fn: (task: UserInfo, error: any) => {
    console.error(`[StoriesService] Fetch effect failed for task ${task.link}:`, error);
    if (task.instanceId) {
      markErrorFx({jobId: task.instanceId, message: error?.message || 'Unknown fetch error'}); // <--- markErrorFx expects object
    } else {
      console.warn('[StoriesService] Missing instanceId for task failure from fetch:', task);
    }
    return;
  },
  target: [taskDone, checkTasks]
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

// Manages $isTaskRunning status.
export const $isTaskRunning = createStore<boolean>(false);
$isTaskRunning.on(taskStarted, () => true);
$isTaskRunning.on(taskDone, () => false);

// Handle temporary message IDs sent during processing
sample({
  clock: tempMessageSent,
  source: $currentTask,
  filter: (currentTaskState: UserInfo | null, msgId: number): currentTaskState is UserInfo => currentTaskState !== null,
  fn: (currentTaskState: UserInfo, msgId: number): UserInfo => {
    return { ...currentTaskState, tempMessages: [...(currentTaskState.tempMessages ?? []), msgId] };
  },
  target: $currentTask
});

// Clear tempMessages array in the current task state after cleanup effect is done
sample({
  clock: cleanupTempMessagesFx.done,
  source: $currentTask,
  filter: (currentTaskState: UserInfo | null, { params: finishedTaskParams }): currentTaskState is UserInfo =>
    currentTaskState !== null && currentTaskState.instanceId === finishedTaskParams.instanceId,
  fn: (currentTaskState: UserInfo) => ({ ...currentTaskState, tempMessages: [] }),
  target: $currentTask
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
