import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';
import { createEffect, createEvent, createStore, sample, combine } from 'effector';
import { bot } from 'index';
import { getRandomArrayItem } from 'lib';
import { saveUser } from 'repositories/user-repository';
import { User } from 'telegraf/typings/core/types/typegram';
import { Api } from 'telegram';

export interface UserInfo {
  chatId: string;
  link: string;
  linkType: 'username' | 'link';
  nextStoriesIds?: number[];
  locale: string;
  user?: User;
  tempMessages?: number[];
  initTime: number;
  isPremium?: boolean;
  // --- Add instanceId for uniqueness ---
  instanceId?: string;
}

// =============================================================================
// STORES & EVENTS
// =============================================================================

const $currentTask = createStore<UserInfo | null>(null);
const $tasksQueue = createStore<UserInfo[]>([]);
const $isTaskRunning = createStore(false);
const $taskStartTime = createStore<Date | null>(null);
const clearTimeoutEvent = createEvent<number>();
const $taskTimeout = createStore(isDevEnv ? 20000 : 240000);

const newTaskReceived = createEvent<UserInfo>();
const taskReadyToBeQueued = createEvent<UserInfo>();
const taskInitiated = createEvent<void>();
const taskStarted = createEvent<UserInfo>();
const tempMessageSent = createEvent<number>();
const checkTasks = createEvent<void>();
const cleanUpTempMessagesFired = createEvent();

// =============================================================================
// INTERNAL: Unique task creation and instanceId
// =============================================================================
function createTask(userInfo: UserInfo): UserInfo {
  return {
    ...userInfo,
    instanceId: `${userInfo.chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
}

// =============================================================================
// DOUBLE-FIRE/RACE CONDITION GUARD
// =============================================================================

let isTaskFinalizing = false;

function finalizeTaskAndProceed() {
  if (isTaskFinalizing) {
    console.warn('[StoriesService] finalizeTaskAndProceed called while already finalizing! Skipping.');
    return;
  }
  isTaskFinalizing = true;

  const prevTask = $currentTask.getState();
  const queue = $tasksQueue.getState();

  // Remove from queue if still present at front (atomic clear)
  if (queue.length > 0 && prevTask && queue[0].link === prevTask.link && queue[0].chatId === prevTask.chatId) {
    $tasksQueue.setState(queue.slice(1));
  }
  $currentTask.setState(null);
  $isTaskRunning.setState(false);

  setTimeout(() => {
    isTaskFinalizing = false;
    checkTasks();
  }, 0); // microtask lets state settle
}

// =============================================================================
// LOGIC AND FLOW
// =============================================================================

sample({
  clock: taskReadyToBeQueued,
  target: checkTasks,
});

const timeoutList = isDevEnv ? [10000, 15000, 20000] : [240000, 300000, 360000];
const clearTimeoutWithDelayFx = createEffect((currentTimeout: number) => {
  const nextTimeout = getRandomArrayItem(timeoutList, currentTimeout);
  setTimeout(() => clearTimeoutEvent(nextTimeout), currentTimeout);
});

const MAX_WAIT_TIME = 7;

const checkTaskForRestart = createEffect(async (task: UserInfo | null) => {
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

const $taskSource = combine({
  currentTask: $currentTask,
  taskStartTime: $taskStartTime,
  taskTimeout: $taskTimeout,
  queue: $tasksQueue,
  user: $currentTask.map(task => task?.user ?? null),
});

const sendWaitMessageFx = createEffect(async (params: {
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

const cleanupTempMessagesFx = createEffect(async (task: UserInfo) => {
  if (task.tempMessages && task.tempMessages.length > 0) {
    await Promise.allSettled(
      task.tempMessages.map(id => bot.telegram.deleteMessage(task.chatId, id).catch(() => null))
    );
  }
});

const saveUserFx = createEffect(saveUser);

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
      return false; // duplicate, filter out
    }
    return true;
  },
  fn: (_, newTask) => createTask(newTask),
  target: taskReadyToBeQueued,
});

// Only listen to pre-filtered, safe event
$tasksQueue.on(taskReadyToBeQueued, (tasks, newTask) => {
  const isPrivileged = newTask.chatId === BOT_ADMIN_ID.toString() || newTask.isPremium === true;
  return isPrivileged ? [newTask, ...tasks] : [...tasks, newTask];
});
$isTaskRunning.on(taskStarted, () => true);
$tasksQueue.on(finalizeTaskAndProceed, (tasks) => tasks.length > 0 ? tasks.slice(1) : []);

sample({
  clock: newTaskReceived,
  filter: (newTask) => !!newTask.user,
  fn: (newTask) => newTask.user!,
  target: saveUserFx,
});

sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: (sourceData, newTask) => {
    const isPrivileged = newTask.chatId === BOT_ADMIN_ID.toString() || newTask.isPremium === true;
    if (!isPrivileged) {
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

sample({
  clock: taskInitiated,
  source: $tasksQueue,
  filter: (q): q is UserInfo[] & { 0: UserInfo } => q.length > 0 && !$isTaskRunning.getState(),
  fn: (q) => q[0],
  target: [$currentTask, taskStarted]
});
sample({
  clock: taskInitiated,
  source: $taskTimeout,
  filter: (t): t is number => t > 0,
  fn: () => new Date(),
  target: $taskStartTime
});
sample({
  clock: taskInitiated,
  source: $taskTimeout,
  filter: (t): t is number => t > 0,
  fn: (t) => t,
  target: clearTimeoutWithDelayFx
});
$taskTimeout.on(clearTimeoutEvent, (_, n) => n);
sample({
  clock: clearTimeoutEvent,
  fn: () => null,
  target: [$taskStartTime, checkTasks]
});
sample({
  clock: taskStarted,
  filter: (t) => t.linkType === 'username',
  target: getAllStoriesFx
});
sample({
  clock: taskStarted,
  filter: (t) => t.linkType === 'link',
  target: getParticularStoryFx
});

// --- Effect Result Handling ---
// No direct sample from .done to checkTasks anymore!
// All finalization goes through finalizeTaskAndProceed

sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task, result) => task !== null && typeof result === 'string',
  fn: (task, message) => ({ task: task!, message: message as string }),
  target: [sendErrorMessageFx],
});
sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task, result) => task !== null && typeof result === 'object' && result !== null,
  fn: (task, result) => ({ task: task!, ...(result as object) }),
  target: sendStoriesFx,
});
getAllStoriesFx.done.watch(() => finalizeTaskAndProceed());
getAllStoriesFx.fail.watch(() => finalizeTaskAndProceed());

sample({
  clock: getParticularStoryFx.doneData,
  source: $currentTask,
  filter: (task, result) => task !== null && typeof result === 'string',
  fn: (task, message) => ({ task: task!, message: message as string }),
  target: [sendErrorMessageFx],
});
sample({
  clock: getParticularStoryFx.doneData,
  source: $currentTask,
  filter: (task, result) => task !== null && typeof result === 'object' && result !== null,
  fn: (task, result) => ({ task: task!, ...(result as object) }),
  target: sendStoriesFx,
});
getParticularStoryFx.done.watch(() => finalizeTaskAndProceed());
getParticularStoryFx.fail.watch(() => finalizeTaskAndProceed());

// --- Finalization Logic ---
sendStoriesFx.done.watch(({ params }) => console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link, params.task.instanceId));
sendStoriesFx.fail.watch(({ params, error }) => console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, params.task.instanceId, 'Error:', error));
// No sample from sendStoriesFx.done/fail to taskDone or checkTasks!

sample({
  clock: finalizeTaskAndProceed,
  source: $currentTask,
  filter: (t): t is UserInfo => t !== null,
  target: cleanupTempMessagesFx
});
$currentTask.on(finalizeTaskAndProceed, () => null);
$isTaskRunning.on(finalizeTaskAndProceed, () => false);
$tasksQueue.on(finalizeTaskAndProceed, (tasks) => tasks.slice(1));

$currentTask.on(tempMessageSent, (prev, msgId) => {
  if (!prev) {
    console.warn("[StoriesService] $currentTask was null when tempMessageSent called.");
    return { chatId: '', link: '', linkType: 'username', locale: 'en', initTime: Date.now(), tempMessages: [msgId] } as UserInfo;
  }
  return { ...prev, tempMessages: [...(prev.tempMessages ?? []), msgId] };
});
$currentTask.on(cleanupTempMessagesFx.done, (prev) => prev ? { ...prev, tempMessages: [] } : null);

// --- Interval Timers ---
const intervalHasPassed = createEvent<void>();
sample({
  clock: intervalHasPassed,
  source: $currentTask,
  filter: (t): t is UserInfo => t !== null,
  target: checkTaskForRestart
});
setInterval(() => intervalHasPassed(), 30_000);

// =========================================================================
//  EXPORTS
// =========================================================================
export { tempMessageSent, cleanUpTempMessagesFired, newTaskReceived, checkTasks };

// Trigger the queue on startup
setTimeout(() => checkTasks(), 100);

