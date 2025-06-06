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
}

// DEBUG LOGGING
const debug = (...args: any[]) => console.log('[StoriesService]', ...args);

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
const taskDone = createEvent<void>();
const checkTasks = createEvent<void>();
const cleanUpTempMessagesFired = createEvent();

// =============================================================================
// LOGIC AND FLOW
// =============================================================================

// 1. Prevent Duplicate Task Processing (Race Condition Fix)
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
      debug(`[TASK REJECTED as duplicate] link=${newTask.link} chatId=${newTask.chatId}`);
      return false;
    }
    debug(`[NEW TASK ACCEPTED] link=${newTask.link} chatId=${newTask.chatId}`);
    return true;
  },
  fn: (_, newTask) => newTask,
  target: taskReadyToBeQueued,
});

// 2. Add to queue
$tasksQueue.on(taskReadyToBeQueued, (tasks, newTask) => {
  const isPrivileged = newTask.chatId === BOT_ADMIN_ID.toString() || newTask.isPremium === true;
  debug(`[QUEUE] Adding task (${newTask.link} by ${newTask.chatId})`, { isPrivileged });
  return isPrivileged ? [newTask, ...tasks] : [...tasks, newTask];
});

// 3. Mark running/not running
$isTaskRunning.on(taskStarted, () => {
  debug('[RUNNING] Task started');
  return true;
}).on(taskDone, () => {
  debug('[RUNNING] Task finished');
  return false;
});

// 4. Remove from queue when done (ALWAYS remove the 1st element)
$tasksQueue.on(taskDone, (tasks) => {
  debug('[QUEUE] Removing finished task, queue before:', tasks.map(t => t.link));
  const newQueue = tasks.length > 0 ? tasks.slice(1) : [];
  debug('[QUEUE] Queue after:', newQueue.map(t => t.link));
  return newQueue;
});

// 5. When a new task is received, save the user (side effect)
sample({
  clock: newTaskReceived,
  filter: (newTask) => !!newTask.user,
  fn: (newTask) => newTask.user!,
  target: createEffect((user) => {
    debug('[DB] Saving user', user?.username || user?.id);
    saveUser(user);
  }),
});

// 6. Show wait message if needed
sample({
  clock: newTaskReceived,
  source: combine({
    currentTask: $currentTask,
    taskStartTime: $taskStartTime,
    taskTimeout: $taskTimeout,
    queue: $tasksQueue,
  }),
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
  target: createEffect(async (params) => {
    debug('[WAIT] Sending wait message', params.newTask.link);
    let estimatedWaitMs = 0;
    if (params.taskStartTime) {
      const elapsed = Date.now() - params.taskStartTime.getTime();
      estimatedWaitMs = Math.max(params.taskTimeout - elapsed, 0) + (params.queueLength * params.taskTimeout);
    }
    const estimatedWaitSec = Math.ceil(estimatedWaitMs / 1000);
    const waitMsg = estimatedWaitSec > 0
      ? `⏳ Please wait: Estimated wait time is ${estimatedWaitSec} seconds before your request starts.`
      : '⏳ Please wait: Your request will start soon.';
    await bot.telegram.sendMessage(params.newTask.chatId, waitMsg);
  }),
});

// 7. Task execution scheduling
const $taskInitiationDataSource = combine({
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
    debug('[SCHEDULER] Next task', nextTaskInQueue.link, { isPrivileged });
    return isPrivileged || sourceValues.currentSystemCooldownStartTime === null;
  },
  target: taskInitiated,
});

// 8. Actually start the task (set $currentTask, fire taskStarted)
sample({
  clock: taskInitiated,
  source: $tasksQueue,
  filter: (q): q is UserInfo[] & { 0: UserInfo } => q.length > 0 && !$isTaskRunning.getState(),
  fn: (q) => q[0],
  target: [
    createEffect((task) => {
      debug('[TASK STARTED]', task.link, 'by', task.chatId);
    }),
    $currentTask,
    taskStarted,
  ]
});

sample({ clock: taskInitiated, source: $taskTimeout, filter: (t): t is number => t > 0, fn: () => new Date(), target: $taskStartTime });

// 9. When the task is done, clean up
sample({ clock: taskDone, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: createEffect((task) => {
  debug('[CLEANUP] Finished task', task.link, 'by', task.chatId);
})});
$currentTask.on(taskDone, () => null);

// --- Effect Result Handling ---

// Handle getAllStoriesFx results
sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task, result) => task !== null && typeof result === 'string',
  fn: (task, message) => ({ task: task!, message: message as string }),
  target: [
    createEffect(({ task }) => debug('[EFFECT] getAllStoriesFx string result', task.link)),
    sendErrorMessageFx,
    taskDone,
    checkTasks,
  ],
});

sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task, result) => task !== null && typeof result === 'object' && result !== null,
  fn: (task, result) => ({ task: task!, ...(result as object) }),
  target: [
    createEffect(({ task }) => debug('[EFFECT] getAllStoriesFx object result', task.link)),
    sendStoriesFx,
  ],
});

getAllStoriesFx.fail.watch(({ params, error }) => {
  debug('[ERROR] getAllStoriesFx.fail', params.link, error);
  taskDone();
  checkTasks();
});

// Handle getParticularStoryFx results
sample({
  clock: getParticularStoryFx.doneData,
  source: $currentTask,
  filter: (task, result) => task !== null && typeof result === 'string',
  fn: (task, message) => ({ task: task!, message: message as string }),
  target: [
    createEffect(({ task }) => debug('[EFFECT] getParticularStoryFx string result', task.link)),
    sendErrorMessageFx,
    taskDone,
    checkTasks,
  ],
});

sample({
  clock: getParticularStoryFx.doneData,
  source: $currentTask,
  filter: (task, result) => task !== null && typeof result === 'object' && result !== null,
  fn: (task, result) => ({ task: task!, ...(result as object) }),
  target: [
    createEffect(({ task }) => debug('[EFFECT] getParticularStoryFx object result', task.link)),
    sendStoriesFx,
  ],
});

getParticularStoryFx.fail.watch(({ params, error }) => {
  debug('[ERROR] getParticularStoryFx.fail', params.link, error);
  taskDone();
  checkTasks();
});

// --- Finalization Logic ---
sendStoriesFx.done.watch(({ params }) => debug('[DONE] sendStoriesFx.done for task:', params.task.link));
sendStoriesFx.fail.watch(({ params, error }) => debug('[FAIL] sendStoriesFx.fail for task:', params.task.link, 'Error:', error));
sample({ clock: sendStoriesFx.done, target: [taskDone, checkTasks] });
sample({ clock: sendStoriesFx.fail, target: [taskDone, checkTasks] });

// --- Timers and Export ---
const intervalHasPassed = createEvent<void>();
sample({ clock: intervalHasPassed, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: createEffect((task) => debug('[TIMER] Checking for stuck/long-running task', task.link, task.chatId)) });
setInterval(() => intervalHasPassed(), 30_000);

export { tempMessageSent, cleanUpTempMessagesFired, newTaskReceived, checkTasks };

setTimeout(() => checkTasks(), 100);
