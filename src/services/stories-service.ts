// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample, combine } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
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
export const taskInitiated = createEvent<void>(); // Still used to initiate processing
export const taskStarted = createEvent<UserInfo>(); // Signal a task has started processing (from DB)
export const tempMessageSent = createEvent<number>(); // To track messages for cleanup
export const taskDone = createEvent<void>(); // Signal a task is completed/failed
export const checkTasks = createEvent<void>(); // Trigger to check for next task in queue
export const cleanUpTempMessagesFired = createEvent(); // To trigger cleanup of temp messages

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
          // CORRECTED LINE: Removed LaTeX delimiters
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

export const saveUserFx = createEffect(saveUser); // saveUser is the utility function imported from repository

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
        console.error(`[StoriesService] Task validation/enqueue failed for ${params.link}:`, error);
        // Optionally notify admin about unhandled validation error
        sendErrorMessageFx({ task: params, message: `Failed to queue task: ${error.message}` });
    }
});


// Logic to trigger task initiation (picking from DB queue)
type TaskInitiationSource = { isRunning: boolean; currentSystemCooldownStartTime: Date | null; };
const $taskInitiationDataSource = combine<TaskInitiationSource>({
  isRunning: createStore<boolean>(false), // $isTaskRunning is implicitly derived from this state
  currentSystemCooldownStartTime: createStore<Date | null>(null) // This needs to be managed if timeouts are still needed.
});

// `checkTasks` now triggers fetching the next item from the DB
export const checkTaskEligibilityFx = createEffect(async (sourceValues: TaskInitiationSource): Promise<boolean> => {
  if (sourceValues.isRunning) return false; // Don't initiate if a task is already running
  const nextJob = await getNextQueueItemFx(); // Fetch next item from DB

  if (!nextJob) { // No job in DB queue
    return false;
  }
  return true; // A job is found and no task is currently running
});

// When `checkTasks` is triggered, run eligibility check
sample({
  clock: checkTasks,
  source: $taskInitiationDataSource,
  target: checkTaskEligibilityFx, // Target the new effect
});

// If eligibility check succeeds, then trigger taskInitiated
sample({
    clock: checkTaskEligibilityFx.doneData,
    filter: (isEligible: boolean) => isEligible, // Only proceed if true
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
  filter: (job: DownloadQueueItem | null): job is DownloadQueueItem => job !== null, // Only proceed if job is found
  fn: (job: DownloadQueueItem) => {
    // Transform DownloadQueueItem from DB into UserInfo for Effector's internal task tracking
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
sample({ clock: taskStarted, filter: (t: UserInfo) => t.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (t: UserInfo) => t.linkType === 'link', target: getParticularStoryFx });

// Removed $taskTimeout.on and sample(clearTimeoutEvent) as they are part of in-memory timeout mechanism.
// Timeouts for tasks should ideally be handled within the fetch effects or by monitoring DB status externally.
// If you still want specific timeouts for the *overall processing*, this logic would need to be re-introduced carefully.


// --- Effect Result Handling ---
// This part transforms the result of get*StoriesFx into SendStoriesFxParams
// to be sent to the sendStoriesFx dispatcher.

// Handle error messages from get*StoriesFx (if they return a string)
sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask, // Get the task from the current active task store
  filter: (task: UserInfo | null, result): result is string => task !== null && typeof result === 'string',
  fn: (task: UserInfo, message: string) => ({ task: task, message: message }),
  target: [sendErrorMessageFx, taskDone, checkTasks], // Target sendErrorMessageFx (the Effect), then cleanup
});

// Handle successful data from get*StoriesFx (if they return an object/array)
sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask, // Source the current active task for full context
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
  if (params.task.instanceId) { // Check before accessing instanceId
    markDoneFx(params.task.instanceId); // Corrected to pass string directly
  } else {
    console.warn('[StoriesService] Missing instanceId for task completion:', params.task);
  }
});
sendStoriesFx.fail.watch(({ params, error }) => {
  console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error);
  if (params.task.instanceId) { // Check before accessing instanceId
    markErrorFx(params.task.instanceId, error?.message || 'Unknown sending error'); // Corrected: pass two strings
  } else {
    console.warn('[StoriesService] Missing instanceId for task failure:', params.task);
  }
});

// Mark task as done and trigger cleanup
sample({
  clock: [getAllStoriesFx.fail, getParticularStoryFx.fail],
  source: $currentTask,
  filter: (task: UserInfo | null): task is UserInfo => task !== null,
  fn: (task: UserInfo, error: any) => { // error is from the clock
    console.error(`[StoriesService] Fetch effect failed for task ${task.link}:`, error);
    if (task.instanceId) { // Check before accessing instanceId
      markErrorFx(task.instanceId, error?.message || 'Unknown fetch error'); // Corrected: pass two strings
    } else {
      console.warn('[StoriesService] Missing instanceId for task failure from fetch:', task);
    }
    return; // Pass nothing to target, as we're just triggering taskDone/checkTasks
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
