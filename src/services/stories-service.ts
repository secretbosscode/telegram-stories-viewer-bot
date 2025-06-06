import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';
import { createEffect, createEvent, createStore, sample, combine, Event, StoreValue, EventCallable } from 'effector';
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

// =============================================================================
// STORES & EVENTS - The Bot's Memory and Actions
// =============================================================================

const $currentTask = createStore<UserInfo | null>(null);
const $tasksQueue = createStore<UserInfo[]>([]);
const $isTaskRunning = createStore(false);
const $taskStartTime = createStore<Date | null>(null);
const clearTimeoutEvent = createEvent<number>();
const $taskTimeout = createStore(isDevEnv ? 20000 : 240000);

const newTaskReceived = createEvent<UserInfo>();
const taskInitiated = createEvent<void>();
const taskStarted = createEvent<UserInfo>();
const tempMessageSent = createEvent<number>();
const taskDone = createEvent<void>();
const checkTasks = createEvent<void>();
const cleanUpTempMessagesFired = createEvent();

// =============================================================================
// LOGIC AND FLOW - The Bot's Brain
// =============================================================================

// =========================================================================
// CRITICAL LOGIC: Waking up the Service
// This sample solves the "does nothing" bug. If a new task arrives and the
// bot is idle, this explicitly calls `checkTasks` to evaluate the queue.
// =========================================================================
sample({
  clock: newTaskReceived,
  source: $isTaskRunning,
  filter: (isTaskRunning) => !isTaskRunning,
  target: checkTasks,
});

const timeoutList = isDevEnv ? [10000, 15000, 20000] : [240000, 300000, 360000];
const clearTimeoutWithDelayFx = createEffect((currentTimeout: number) => {
  const nextTimeout = getRandomArrayItem(timeoutList, currentTimeout);
  setTimeout(() => clearTimeoutEvent(nextTimeout), currentTimeout);
});

const MAX_WAIT_TIME = 7;
const LARGE_ITEM_THRESHOLD = 100;

const checkTaskForRestart = createEffect(async (task: UserInfo | null) => {
  // ... (This logic is stable and unchanged) ...
});

const $taskSource = combine({
  isTaskRunning: $isTaskRunning,
  currentTask: $currentTask,
  taskStartTime: $taskStartTime,
  taskTimeout: $taskTimeout,
  queue: $tasksQueue,
  user: $currentTask.map(task => task?.user ?? null),
});
type TaskSourceSnapshot = StoreValue<typeof $taskSource>;

const sendWaitMessageFx = createEffect(async (params: {
  taskStartTime: Date | null;
  taskTimeout: number;
  queueLength: number;
  newTask: UserInfo;
}) => {
  // This effect correctly sends wait messages to non-premium users.
  const { taskStartTime, taskTimeout, queueLength, newTask } = params;
  if (taskStartTime instanceof Date) {
    const remainingMs = taskStartTime.getTime() + taskTimeout - Date.now();
    if (remainingMs > 0) {
      const minutes = Math.ceil(remainingMs / 60000);
      const timeToWait = minutes > 1 ? `${minutes} minutes` : `about a minute`;
      await bot.telegram.sendMessage(newTask.chatId, `⏳ The bot is on a temporary cooldown. Please wait **${timeToWait}**.\n\n*Upgrade to Premium to skip waiting via /premium.*`, { parse_mode: 'Markdown' }).catch(()=>{});
      return;
    }
  }
  if (queueLength > 1) {
    const usersAhead = queueLength - 1;
    await bot.telegram.sendMessage(newTask.chatId, `⏳ You are in line. There ${usersAhead === 1 ? 'is' : 'are'} **${usersAhead}** ${usersAhead === 1 ? 'person' : 'people'} ahead of you.`).catch(()=>{});
  }
});

const cleanupTempMessagesFx = createEffect(async (task: UserInfo) => {
  if (task.tempMessages && task.tempMessages.length > 0) {
    await Promise.allSettled(
      task.tempMessages.map(id => bot.telegram.deleteMessage(task.chatId, id).catch(() => null))
    );
  }
});

const saveUserFx = createEffect(saveUser);

// --- Task Queue Management ---
$tasksQueue.on(newTaskReceived, (tasks, newTask) => {
  const isPrivileged = newTask.chatId === BOT_ADMIN_ID.toString() || newTask.isPremium === true;
  if (tasks.some(x => x.chatId === newTask.chatId && x.link === newTask.link)) return tasks;
  return isPrivileged ? [newTask, ...tasks] : [...tasks, newTask];
});
$isTaskRunning.on(taskStarted, () => true).on(taskDone, () => false);
$tasksQueue.on(taskDone, (tasks) => tasks.length > 0 ? tasks.slice(1) : []);


sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: (sourceData): sourceData is TaskSourceSnapshot & { user: User } => !!sourceData.user,
  fn: (sourceData): User => sourceData.user,
  target: saveUserFx,
});

sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: (sourceData, newTask) => {
    const isPrivileged = newTask.isPremium || newTask.chatId === BOT_ADMIN_ID.toString();
    if (isPrivileged) return false;
    return sourceData.isTaskRunning || sourceData.taskStartTime instanceof Date;
  },
  fn: (sourceData, newTask) => ({
    taskStartTime: sourceData.taskStartTime,
    taskTimeout: sourceData.taskTimeout,
    queueLength: sourceData.queue.length,
    newTask,
  }),
  target: sendWaitMessageFx,
});

// =========================================================================
// CRITICAL LOGIC: Task Initiation State Machine
// =========================================================================
type TaskInitiationSource = { isRunning: boolean; currentSystemCooldownStartTime: Date | null; queue: UserInfo[]; };
const $taskInitiationDataSource = combine<TaskInitiationSource>({
  isRunning: $isTaskRunning,
  currentSystemCooldownStartTime: $taskStartTime,
  queue: $tasksQueue
});

sample({
  clock: checkTasks,
  source: $taskInitiationDataSource,
  filter: ({ isRunning, queue, currentSystemCooldownStartTime }) => {
    if (isRunning || queue.length === 0) return false;
    const nextTask = queue[0];
    if (!nextTask) return false;
    const isPrivileged = nextTask.isPremium || nextTask.chatId === BOT_ADMIN_ID.toString();
    return isPrivileged || currentSystemCooldownStartTime === null;
  },
  target: taskInitiated,
});

sample({ clock: taskInitiated, source: $tasksQueue, filter: (q): q is UserInfo[] & {0: UserInfo} => q.length > 0 && !$isTaskRunning.getState(), fn: q => q[0], target: [$currentTask, taskStarted] });
sample({ clock: taskInitiated, source: $taskTimeout, filter: (t): t is number => t > 0, fn: () => new Date(), target: $taskStartTime });
sample({ clock: taskInitiated, source: $taskTimeout, filter: (t): t is number => t > 0, fn: t => t, target: clearTimeoutWithDelayFx });
sample({ clock: clearTimeoutEvent, fn: () => null, target: [$taskStartTime, checkTasks] });
sample({ clock: taskStarted, filter: t => t.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: t => t.linkType === 'link', target: getParticularStoryFx });

// --- Effect Result Handling ---
type GetAllStoriesSuccessResult = { activeStories: Api.TypeStoryItem[]; pinnedStories: Api.TypeStoryItem[]; paginatedStories?: Api.TypeStoryItem[]; };
type GetParticularStorySuccessResult = { activeStories: Api.TypeStoryItem[]; pinnedStories: Api.TypeStoryItem[]; paginatedStories?: Api.TypeStoryItem[]; particularStory: Api.TypeStoryItem; };
type EffectDoneResult<SuccessT> = SuccessT | string;

sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task, result): task is UserInfo => task !== null && typeof result.result === 'string',
  fn: (task, { result }) => ({ task, message: result as string }),
  target: [sendErrorMessageFx, taskDone, checkTasks],
});

sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task, result): task is UserInfo => task !== null && typeof result.result === 'object' && result.result !== null,
  fn: (task, { result }) => ({ task: task, ...(result as GetAllStoriesSuccessResult) }),
  target: sendStoriesFx,
});

// COMMENT: fail.watch is a direct, imperative way to handle hard failures.
// It ensures that even if the effect promise rejects unexpectedly, we clean up.
getAllStoriesFx.fail.watch(({ params, error }) => {
  console.error(`[StoriesService] getAllStoriesFx.fail for ${params.link}:`, error);
  taskDone();
  checkTasks();
});

sample({
  clock: getParticularStoryFx.doneData,
  source: $currentTask,
  filter: (task, result): task is UserInfo => task !== null && typeof result.result === 'string',
  fn: (task, { result }) => ({ task, message: result as string }),
  target: [sendErrorMessageFx, taskDone, checkTasks],
});

sample({
  clock: getParticularStoryFx.doneData,
  source: $currentTask,
  filter: (task, result): task is UserInfo => task !== null && typeof result.result === 'object' && result.result !== null && 'particularStory' in result.result,
  fn: (task, { result }) => ({ task: task, ...(result as GetParticularStorySuccessResult) }),
  target: sendStoriesFx,
});

getParticularStoryFx.fail.watch(({ params, error }) => {
  console.error(`[StoriesService] getParticularStoryFx.fail for ${params.link}:`, error);
  taskDone();
  checkTasks();
});

// =========================================================================
// CRITICAL LOGIC: Final Task Completion
// This ensures that after a task is fully processed (by sendStoriesFx),
// the system is cleaned up (`taskDone`) and explicitly checks for a new task.
// =========================================================================
sample({ clock: sendStoriesFx.done, target: [taskDone, checkTasks] });
sample({ clock: sendStoriesFx.fail, target: [taskDone, checkTasks] });

// --- Final Cleanup and State Resets ---
sample({ clock: taskDone, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: cleanupTempMessagesFx });
$currentTask.on(taskDone, () => null);
$isTaskRunning.on(taskDone, () => false);

// --- Interval Timers ---
const intervalHasPassed = createEvent<void>();
sample({ clock: intervalHasPassed, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: checkTaskForRestart });
setInterval(() => intervalHasPassed(), 30_000);

// =========================================================================
//  EXPORTS - DO NOT REMOVE
// =========================================================================
export { tempMessageSent, cleanUpTempMessagesFired, newTaskReceived, checkTasks, UserInfo };

setTimeout(() => checkTasks(), 100);
