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
// STORES & EVENTS
// =============================================================================

const $currentTask = createStore<UserInfo | null>(null);
const $tasksQueue = createStore<UserInfo[]>([]);
const $isTaskRunning = createStore(false);
const $taskStartTime = createStore<Date | null>(null); // For system-wide (non-privileged user) cooldown
const clearTimeoutEvent = createEvent<number>();
const $taskTimeout = createStore(isDevEnv ? 20000 : 240000);

const newTaskReceived = createEvent<UserInfo>();
const taskInitiated = createEvent<void>();
const taskStarted = createEvent<UserInfo>();
const tempMessageSent = createEvent<number>();
const taskDone = createEvent<void>();
const checkTasks = createEvent<void>(); // The main trigger to check if a new task can be started
const cleanUpTempMessagesFired = createEvent();

// =============================================================================
// LOGIC AND FLOW
// =============================================================================

// --- Waking up the Service ---
// [BUG FIX] This sample solves the "does nothing" bug.
// If a new task arrives and the bot is idle, this explicitly calls `checkTasks`
// to start processing the queue. The filter prevents this from firing if a task
// is already running, which avoids interfering with the normal queue flow.
sample({
  clock: newTaskReceived,
  source: $isTaskRunning,
  filter: (isTaskRunning) => !isTaskRunning, // Only run if no task is currently running
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
type TaskSourceSnapshot = StoreValue<typeof $taskSource>;

const sendWaitMessageFx = createEffect(async (params: {
  multipleRequests: boolean;
  taskStartTime: Date | null;
  taskTimeout: number;
  queueLength: number;
  newTask: UserInfo;
}) => {
    // ... implementation of sendWaitMessageFx ...
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
  filter: (sourceData: TaskSourceSnapshot): sourceData is TaskSourceSnapshot & { user: User } => !!sourceData.user,
  fn: (sourceData: TaskSourceSnapshot & { user: User }): User => sourceData.user,
  target: saveUserFx,
});

sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: (sourceData: TaskSourceSnapshot, newTask: UserInfo): boolean => {
    const { taskStartTime, currentTask } = sourceData;
    const isPrivileged = newTask.chatId === BOT_ADMIN_ID.toString() || newTask.isPremium === true;
    if (!isPrivileged) {
      return ($isTaskRunning.getState() && currentTask?.chatId !== newTask.chatId) || (taskStartTime instanceof Date);
    }
    return false;
  },
  fn: (sourceData: TaskSourceSnapshot, newTask: UserInfo) => ({
    multipleRequests: ($isTaskRunning.getState() && sourceData.currentTask?.chatId !== newTask.chatId),
    taskStartTime: sourceData.taskStartTime,
    taskTimeout: sourceData.taskTimeout,
    queueLength: sourceData.queue.filter(t => t.chatId !== newTask.chatId && t.link !== newTask.link).length,
    newTask,
  }),
  target: sendWaitMessageFx,
});

// --- Task Initiation Core Logic ---
type TaskInitiationSource = { isRunning: boolean; currentSystemCooldownStartTime: Date | null; queue: UserInfo[]; };
const $taskInitiationDataSource = combine<TaskInitiationSource>({
  isRunning: $isTaskRunning,
  currentSystemCooldownStartTime: $taskStartTime,
  queue: $tasksQueue
});

// [BUG FIX] The clock is now ONLY `checkTasks`.
// Using `$tasksQueue.updates` here previously caused an immediate restart loop,
// because `taskDone` would cause a queue update, which would re-trigger this logic instantly.
// Now, a new task is only considered when `checkTasks` is explicitly called.
sample({
  clock: checkTasks,
  source: $taskInitiationDataSource,
  filter: (sourceValues: TaskInitiationSource): boolean => {
    if (sourceValues.isRunning || sourceValues.queue.length === 0) return false;
    const nextTaskInQueue = sourceValues.queue[0];
    if (!nextTaskInQueue) return false;
    const isPrivileged = nextTaskInQueue.chatId === BOT_ADMIN_ID.toString() || nextTaskInQueue.isPremium === true;
    return isPrivileged || sourceValues.currentSystemCooldownStartTime === null;
  },
  target: taskInitiated,
});

sample({ clock: taskInitiated, source: $tasksQueue, filter: (q: UserInfo[]): q is UserInfo[] & { 0: UserInfo } => q.length > 0 && !$isTaskRunning.getState(), fn: (q: UserInfo[] & { 0: UserInfo }) => q[0], target: [$currentTask, taskStarted]});
sample({ clock: taskInitiated, source: $taskTimeout, filter: (t): t is number => typeof t === 'number' && t > 0, fn: (): Date => new Date(), target: $taskStartTime });
sample({ clock: taskInitiated, source: $taskTimeout, filter: (t): t is number => typeof t === 'number' && t > 0, fn: (t: number) => t, target: clearTimeoutWithDelayFx });
$taskTimeout.on(clearTimeoutEvent, (_, n) => n);
sample({ clock: clearTimeoutEvent, fn: (): null => null, target: [$taskStartTime, checkTasks] }); // Cooldown timer completion also checks for new tasks
sample({ clock: taskStarted, filter: (t: UserInfo): t is UserInfo => t.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (t: UserInfo): t is UserInfo => t.linkType === 'link', target: getParticularStoryFx });


// --- Effect Result Handling ---
type GetAllStoriesSuccessResult = { activeStories: Api.TypeStoryItem[]; pinnedStories: Api.TypeStoryItem[]; paginatedStories?: Api.TypeStoryItem[]; };
type GetParticularStorySuccessResult = { activeStories: Api.TypeStoryItem[]; pinnedStories: Api.TypeStoryItem[]; paginatedStories?: Api.TypeStoryItem[]; particularStory: Api.TypeStoryItem; };
type EffectDoneResult<SuccessT> = SuccessT | string;

// NOTE: The following `sample` blocks assume that `effect.doneData`'s payload is being inferred
// by TypeScript as `EffectDoneResult<T>` (i.e., `SuccessObject | string`). The `params` for the
// task (`UserInfo`) are sourced from `$currentTask`, which should hold the task that just finished.
// This pattern was chosen to resolve a series of complex TS errors.

sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task: UserInfo | null, effectResult: EffectDoneResult<GetAllStoriesSuccessResult>): task is UserInfo =>
    task !== null && typeof effectResult === 'string',
  fn: (task: UserInfo, effectResultFromClock: EffectDoneResult<GetAllStoriesSuccessResult>) => {
    const errorMessage = effectResultFromClock as string;
    return { task, message: errorMessage };
  },
  // [BUG FIX] When a task ends (even with a handled error), we must call taskDone AND checkTasks.
  target: [sendErrorMessageFx, taskDone, checkTasks],
});

sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task: UserInfo | null, effectResult: EffectDoneResult<GetAllStoriesSuccessResult>): task is UserInfo =>
    task !== null && typeof effectResult === 'object' && effectResult !== null,
  fn: (task: UserInfo, effectResult: EffectDoneResult<GetAllStoriesSuccessResult>) => {
    const successResult = effectResult as GetAllStoriesSuccessResult;
    if ((successResult.activeStories?.length || 0) + (successResult.pinnedStories?.length || 0) > LARGE_ITEM_THRESHOLD) {
      // ... send long task warning
    }
    return {
      task: task,
      activeStories: successResult.activeStories || [],
      pinnedStories: successResult.pinnedStories || [],
      paginatedStories: successResult.paginatedStories,
      particularStory: undefined,
    };
  },
  target: sendStoriesFx,
});
getAllStoriesFx.fail.watch(({ params, error }) => {
    console.error(`[StoriesService] getAllStoriesFx.fail for ${params.link}:`, error);
    // [BUG FIX] On hard failure, ensure we clean up and check for the next task to prevent a system halt.
    taskDone();
    checkTasks();
});

sample({
  clock: getParticularStoryFx.doneData,
  source: $currentTask,
  filter: (task: UserInfo | null, effectResult: EffectDoneResult<GetParticularStorySuccessResult>): task is UserInfo =>
    task !== null && typeof effectResult === 'string',
  fn: (task: UserInfo, effectResultFromClock: EffectDoneResult<GetParticularStorySuccessResult>) => {
    const errorMessage = effectResultFromClock as string;
    return { task, message: errorMessage };
  },
  target: [sendErrorMessageFx, taskDone, checkTasks],
});

sample({
  clock: getParticularStoryFx.doneData,
  source: $currentTask,
  filter: (task: UserInfo | null, effectResult: EffectDoneResult<GetParticularStorySuccessResult>): task is UserInfo =>
    task !== null && typeof effectResult === 'object' && effectResult !== null && 'particularStory' in effectResult && (effectResult as GetParticularStorySuccessResult).particularStory !== undefined,
  fn: (task: UserInfo, effectResult: EffectDoneResult<GetParticularStorySuccessResult>) => {
    const successResult = effectResult as GetParticularStorySuccessResult & { particularStory: Api.TypeStoryItem };
    return {
      task: task,
      activeStories: successResult.activeStories || [],
      pinnedStories: successResult.pinnedStories || [],
      paginatedStories: successResult.paginatedStories,
      particularStory: successResult.particularStory,
    };
  },
  target: sendStoriesFx,
});
getParticularStoryFx.fail.watch(({ params, error }) => {
    console.error(`[StoriesService] getParticularStoryFx.fail for ${params.link}:`, error);
    // [BUG FIX] On hard failure, ensure we clean up and check for the next task.
    taskDone();
    checkTasks();
});

// --- Final Task Completion ---
sendStoriesFx.done.watch(({ params }) => console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link));
sendStoriesFx.fail.watch(({ params, error }) => console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error));

// [BUG FIX] After sendStoriesFx finishes (success or fail), clean up with taskDone AND explicitly look for a new task with checkTasks.
sample({ clock: sendStoriesFx.done, target: [taskDone, checkTasks] });
sample({ clock: sendStoriesFx.fail, target: [taskDone, checkTasks] });

sample({ clock: taskDone, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: cleanupTempMessagesFx });
sample({ clock: cleanUpTempMessagesFired, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: cleanupTempMessagesFx });

$currentTask.on(tempMessageSent, (prev, msgId) => {
  if (!prev) {
    console.warn("[StoriesService] $currentTask was null when tempMessageSent called.");
    return { chatId: '', link: '', linkType: 'username', locale: 'en', initTime: Date.now(), tempMessages: [msgId] } as UserInfo;
  }
  return { ...prev, tempMessages: [...(prev.tempMessages ?? []), msgId] };
});
$currentTask.on(cleanupTempMessagesFx.done, (prev) => prev ? { ...prev, tempMessages: [] } : null);
$currentTask.on(taskDone, () => null);

// --- Interval Timers ---
const intervalHasPassed = createEvent<void>();
sample({ clock: intervalHasPassed, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: checkTaskForRestart });
setInterval(() => intervalHasPassed(), 30_000);

export { tempMessageSent, cleanUpTempMessagesFired, newTaskReceived, checkTasks };
setTimeout(() => checkTasks(), 100); // Initial check on startup
