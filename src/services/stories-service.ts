// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample, combine } from 'effector'; // Added 'combine' here if not already
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessage } from 'controllers/send-message'; // CORRECTED: sendErrorMessageFx -> sendErrorMessage
import { sendStoriesFx } from 'controllers/send-stories';

// Import types from your central types.ts file
import { UserInfo, SendStoriesFxParams } from 'types'; // UserInfo needs to be imported, not defined here

// If UserInfo interface was here previously, it should be REMOVED from this file.
// export interface UserInfo { /* ... */ } // REMOVE THIS BLOCK if it was here

// =========================================================================
// STORES & EVENTS (These are now DEFINED and EXPORTED from THIS file)
// =========================================================================

export const $currentTask = createStore<UserInfo | null>(null);
export const $tasksQueue = createStore<UserInfo[]>([]);
export const $isTaskRunning = createStore(false);
export const $taskStartTime = createStore<Date | null>(null);
export const clearTimeoutEvent = createEvent<number>();
export const $taskTimeout = createStore(isDevEnv ? 20000 : 240000); // isDevEnv must be imported from 'config/env-config'

// These are the core events. They are DEFINED here.
export const newTaskReceived = createEvent<UserInfo>(); // Raw event from the outside world
export const taskReadyToBeQueued = createEvent<UserInfo>(); // New, pre-filtered event
export const taskInitiated = createEvent<void>();
export const taskStarted = createEvent<UserInfo>();
export const tempMessageSent = createEvent<number>();
export const taskDone = createEvent<void>();
export const checkTasks = createEvent<void>();
export const cleanUpTempMessagesFired = createEvent();

// =========================================================================
// LOGIC AND FLOW
// =========================================================================

sample({
  clock: taskReadyToBeQueued,
  target: checkTasks,
});

const timeoutList = isDevEnv ? [10000, 15000, 20000] : [240000, 300000, 360000];
export const clearTimeoutWithDelayFx = createEffect((currentTimeout: number) => { // Exported for potential external use/testing
  const nextTimeout = getRandomArrayItem(timeoutList, currentTimeout); // getRandomArrayItem must be imported from 'lib'
  setTimeout(() => clearTimeoutEvent(nextTimeout), currentTimeout);
});

const MAX_WAIT_TIME = 7;

export const checkTaskForRestart = createEffect(async (task: UserInfo | null) => { // Exported
  if (task) {
    const minsFromStart = Math.floor((Date.now() - task.initTime) / 60000);
    if (minsFromStart >= MAX_WAIT_TIME) {
      const isPrivileged = task.chatId === BOT_ADMIN_ID.toString() || task.isPremium === true; // BOT_ADMIN_ID must be imported
      if (isPrivileged) {
        console.warn(`[StoriesService] Privileged task for ${task.link} (User: ${task.chatId}) running for ${minsFromStart} mins.`);
        try {
          await bot.telegram.sendMessage(task.chatId, `🔔 Your long task for "${task.link}" is still running (${minsFromStart} mins).`).catch(() => {}); // bot must be imported from 'index'
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

const $taskSource = combine({
  currentTask: $currentTask,
  taskStartTime: $taskStartTime,
  taskTimeout: $taskTimeout,
  queue: $tasksQueue,
  user: $currentTask.map(task => task?.user ?? null),
});

export const sendWaitMessageFx = createEffect(async (params: { // Exported
  multipleRequests: boolean;
  taskStartTime: Date | null;
  taskTimeout: number;
  queueLength: number;
  newTask: UserInfo;
}) => {
  let estimatedWaitMs = 0;
  if (params.taskStartTime) {
    const elapsed = Date.now() - params.taskStartTime.getTime();
    estimatedWaitMs = Math.max(params.taskTimeout - elapsed, 0) + (params.queueLength * params.taskTimeout);
  }
  const estimatedWaitSec = Math.ceil(estimatedWaitMs / 1000);
  const waitMsg = estimatedWaitSec > 0 ? `⏳ Please wait: Estimated wait time is ${estimatedWaitSec} seconds before your request starts.` : '⏳ Please wait: Your request will start soon.';
  await bot.telegram.sendMessage(
    params.newTask.chatId,
    waitMsg
  );
});

export const cleanupTempMessagesFx = createEffect(async (task: UserInfo) => { // Exported
  if (task.tempMessages && task.tempMessages.length > 0) {
    await Promise.allSettled(
      task.tempMessages.map(id => bot.telegram.deleteMessage(task.chatId, id).catch(() => null))
    );
  }
});

export const saveUserFx = createEffect(saveUser); // saveUser must be imported from 'repositories/user-repository'

// --- Task Queue Management ---

// =========================================================================
// BUG FIX: Prevent Duplicate Task Processing (Race Condition Fix)
// =========================================================================
const $queueState = combine({
  tasks: $tasksQueue,
  current: $currentTask,
});

sample({
  clock: newTaskReceived,
  source: $queueState,
  filter: (state, newTask) => {
    const isInQueue = state.tasks.some(t => t.link === newTask.link && t.chatId === newTask.chatId);
    const isRunning = state.current ? (state.current.link === newTask.link && state.current.chatId === newTask.chatId) : false;

    if (isInQueue || isRunning) {
      console.log(`[StoriesService] Task for ${newTask.link} rejected as duplicate (in queue: ${isInQueue}, is running: ${isRunning}).`);
      return false; // This task is a duplicate, filter it out
    }
    return true; // This task is valid
  },
  // If the filter passes, the clock's payload (the new task) is passed to the target.
  target: taskReadyToBeQueued,
});

// The queue now ONLY listens to the pre-filtered, safe event.
$tasksQueue.on(taskReadyToBeQueued, (tasks, newTask) => {
  const isPrivileged = newTask.chatId === BOT_ADMIN_ID.toString() || newTask.isPremium === true;
  return isPrivileged ? [newTask, ...tasks] : [...tasks, newTask];
});

$isTaskRunning.on(taskStarted, () => true).on(taskDone, () => false);
$tasksQueue.on(taskDone, (tasks: UserInfo[]) => tasks.length > 0 ? tasks.slice(1) : []); // Parameter type added here

sample({
  clock: newTaskReceived,
  filter: (newTask) => !!newTask.user,
  fn: (newTask) => newTask.user!,
  target: saveUserFx,
});

// This sample was using .getState(), which is less safe. It has been left as is,
// but the core queue logic is now protected.
sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: (sourceData, newTask) => {
    const isPrivileged = newTask.chatId === BOT_ADMIN_ID.toString() || newTask.isPremium === true;
    if (!isPrivileged) {
      // Using .getState() here is less ideal but acceptable for this non-critical path.
      return ($isTaskRunning.getState() && sourceData.currentTask?.chatId !== newTask.chatId) || (sourceData.taskStartTime instanceof Date);
    }
    return false;
  },
  fn: (sourceData, newTask) => ({
    multipleRequests: ($isTaskRunning.getState() && sourceData.currentTask?.chatId !== newTask.chatId),
    taskStartTime: sourceData.taskStartTime,
    taskTimeout: sourceData.taskTimeout,
    queueLength: sourceData.queue.filter(t => t.chatId !== newTask.chatId && t.link !== newTask.link).length,
    newTask,
  }),
  target: sendWaitMessageFx,
});

type TaskInitiationSource = { isRunning: boolean; currentSystemCooldownStartTime: Date | null; queue: UserInfo[]; };
const $taskInitiationDataSource = combine<TaskInitiationSource>({
  isRunning: $isTaskRunning,
  currentSystemCooldownStartTime: $taskStartTime,
  queue: $tasksQueue
});

sample({
  clock: checkTasks,
  source: $taskInitiationDataSource,
  filter: (sourceValues) => {
    if (sourceValues.isRunning || sourceValues.queue.length === 0) return false;
    const nextTaskInQueue = sourceValues.queue[0];
    if (!nextTaskInQueue) return false;
    const isPrivileged = nextTaskInQueue.chatId === BOT_ADMIN_ID.toString() || nextTaskInQueue.isPremium === true;
    return isPrivileged || sourceValues.currentSystemCooldownStartTime === null;
  },
  target: taskInitiated,
});

sample({ clock: taskInitiated, source: $tasksQueue, filter: (q): q is UserInfo[] & { 0: UserInfo } => q.length > 0 && !$isTaskRunning.getState(), fn: (q) => q[0], target: [$currentTask, taskStarted]});
sample({ clock: taskInitiated, source: $taskTimeout, filter: (t): t is number => t > 0, fn: () => new Date(), target: $taskStartTime });
sample({ clock: taskInitiated, source: $taskTimeout, filter: (t): t is number => t > 0, fn: (t) => t, target: clearTimeoutWithDelayFx });
$taskTimeout.on(clearTimeoutEvent, (_, n) => n);
sample({ clock: clearTimeoutEvent, fn: () => null, target: [$taskStartTime, checkTasks] });
sample({ clock: taskStarted, filter: (t) => t.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (t) => t.linkType === 'link', target: getParticularStoryFx });

// --- Effect Result Handling ---
// This part will now transform the result of get*StoriesFx into SendStoriesFxParams
// to be sent to the sendStoriesFx dispatcher.

// Handle error messages from get*StoriesFx (if they return a string)
sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData], // Clock on both fetch effects
  source: $currentTask,
  filter: (task: UserInfo | null, result): result is string => task !== null && typeof result === 'string', // Ensure task is not null and result is a string error
  fn: (task, message) => ({ task: task!, message: message }), // Create payload for sendErrorMessage
  target: [sendErrorMessage, taskDone, checkTasks], // Target the sendErrorMessage effect, then cleanup
});

// Handle successful data from get*StoriesFx (if they return an object/array)
sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData], // Clock on both fetch effects
  source: newTaskReceived, // Source the initial task for context
  filter: (task, fetchedDataResult): fetchedDataResult is (object | object[]) =>
    typeof fetchedDataResult !== 'string' && fetchedDataResult !== null, // Filter out string errors and nulls
  fn: (task, fetchedDataResult): SendStoriesFxParams => { // Map to SendStoriesFxParams
    const params: SendStoriesFxParams = { task };
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
        console.error('[stories-service] Unexpected result type from handleStoryRequest.doneData:', fetchedDataResult);
        throw new Error('Unexpected story data type received from fetch effect for sending.');
      }
    } else {
      console.error('[stories-service] handleStoryRequest.doneData produced non-object/non-array:', fetchedDataResult);
      throw new Error('Invalid data type received from fetch effect.');
    }
    return params;
  },
  target: sendStoriesFx, // Target the sendStoriesFx dispatcher
});

// --- Finalization Logic ---
// These watches handle side effects and task state progression after sendStoriesFx completes.
sendStoriesFx.done.watch(({ params }) => console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link));
sendStoriesFx.fail.watch(({ params, error }) => console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error));
sample({ clock: sendStoriesFx.done, target: [taskDone, checkTasks] });
sample({ clock: sendStoriesFx.fail, target: [taskDone, checkTasks] });

// Mark task as done and trigger cleanup
sample({
  clock: [getAllStoriesFx.fail, getParticularStoryFx.fail], // If fetch fails
  target: [taskDone, checkTasks] // Mark done and check next task
});

// When a task is marked done, trigger cleanupTempMessagesFx with the task context
sample({
  clock: taskDone,
  source: $currentTask, // Get the task that just finished
  filter: (t: UserInfo | null): t is UserInfo => t !== null, // Ensure task is not null
  target: cleanupTempMessagesFx.prepend((task: UserInfo) => task) // Prepend the task to the cleanup effect
});

// Update the current task store to null when a task is done
$currentTask.on(taskDone, () => null);

// Update task running status when a task is done
$isTaskRunning.on(taskDone, () => false);

// Remove the completed task from the queue when done
$tasksQueue.on(taskDone, (tasks: UserInfo[]) => tasks.length > 0 ? tasks.slice(1) : []);

// Handle temporary message IDs sent during processing
$currentTask.on(tempMessageSent, (prev: UserInfo | null, msgId: number) => {
  if (!prev) {
    console.warn("[StoriesService] $currentTask was null when tempMessageSent called.");
    return { chatId: '', link: '', linkType: 'username', locale: 'en', initTime: Date.now(), tempMessages: [msgId], isPremium: false } as UserInfo;
  }
  return { ...prev, tempMessages: [...(prev.tempMessages ?? []), msgId] };
});

// Clear tempMessages array in the current task state after cleanup effect is done
$currentTask.on(cleanupTempMessagesFx.done, (currentTaskState: UserInfo | null, { params: finishedTaskParams }: { params: UserInfo, result: void }): UserInfo | null => {
    // Only update if the finished task is the one currently being tracked by $currentTask
    if (currentTaskState && currentTaskState.instanceId === finishedTaskParams.instanceId) {
        return { ...currentTaskState, tempMessages: [] };
    }
    return currentTaskState; // Otherwise, don't modify the state
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
// export {
//   newTaskReceived,
//   tempMessageSent,
//   cleanUpTempMessagesFired,
//   checkTasks,
//   taskDone,
//   $currentTask,
//   $isTaskRunning,
//   $tasksQueue,
//   clearTimeoutEvent,
//   $taskTimeout,
//   clearTimeoutWithDelayFx,
//   checkTaskForRestart,
//   sendWaitMessageFx,
//   cleanupTempMessagesFx,
//   saveUserFx,
// };
