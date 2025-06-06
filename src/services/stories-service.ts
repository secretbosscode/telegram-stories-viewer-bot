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
// CORE LOGIC - The Bot's Brain
// =============================================================================

// =========================================================================
// CRITICAL LOGIC: Waking up the Service
// DO NOT MODIFY without careful consideration.
// -------------------------------------------------------------------------
// This sample solves the "does nothing" bug. If a new task arrives, it
// explicitly calls `checkTasks` to evaluate the queue. This was changed
// from a previous version that checked `$isTaskRunning` to be more robust,
// ensuring the queue is always checked when a new item is added.
// =========================================================================
sample({
  clock: newTaskReceived,
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

// This combined store provides a consistent snapshot of state for our logic.
const $taskSource = combine({
  isTaskRunning: $isTaskRunning, // Added for reliable state checks
  currentTask: $currentTask,
  taskStartTime: $taskStartTime,
  taskTimeout: $taskTimeout,
  queue: $tasksQueue,
  user: $currentTask.map(task => task?.user ?? null),
});
type TaskSourceSnapshot = StoreValue<typeof $taskSource>;

// EFFECT: Send a message with estimated wait time for non-premium users.
const sendWaitMessageFx = createEffect(async (params: {
  taskStartTime: Date | null;
  taskTimeout: number;
  queueLength: number;
  newTask: UserInfo;
}) => {
  const { taskStartTime, taskTimeout, queueLength, newTask } = params;

  if (taskStartTime instanceof Date) {
    const remainingMs = taskStartTime.getTime() + taskTimeout - Date.now();
    if (remainingMs > 0) {
      const minutes = Math.ceil(remainingMs / 60000);
      const timeToWait = minutes > 1 ? `${minutes} minutes` : `about a minute`;
      await bot.telegram.sendMessage(
        newTask.chatId,
        `⏳ The bot is on a temporary cooldown. Please wait **${timeToWait}** before trying again.\n\n*You can get unlimited access without waiting by running /premium.*`,
        { parse_mode: 'Markdown' }
      ).catch(()=>{});
      return;
    }
  }

  if (queueLength > 1) {
    const usersAhead = queueLength - 1;
    await bot.telegram.sendMessage(newTask.chatId, `⏳ You are in the queue. There ${usersAhead === 1 ? 'is' : 'are'} **${usersAhead}** ${usersAhead === 1 ? 'person' : 'people'} ahead of you. Please wait.`).catch(()=>{});
  }
});

const cleanupTempMessagesFx = createEffect(async (task: UserInfo) => { /* ... */ });
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

// This sample handles notifying non-privileged users if they have to wait.
sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: (sourceData: TaskSourceSnapshot, newTask: UserInfo): boolean => {
    const isPrivileged = newTask.chatId === BOT_ADMIN_ID.toString() || newTask.isPremium === true;
    if (isPrivileged) return false;
    return sourceData.isTaskRunning || sourceData.taskStartTime instanceof Date;
  },
  fn: (sourceData: TaskSourceSnapshot, newTask: UserInfo) => ({
    taskStartTime: sourceData.taskStartTime,
    taskTimeout: sourceData.taskTimeout,
    queueLength: sourceData.queue.length,
    newTask: newTask,
  }),
  target: sendWaitMessageFx,
});

// =========================================================================
// CRITICAL LOGIC: Task Initiation State Machine
// DO NOT MODIFY without careful consideration.
// -------------------------------------------------------------------------
// This section defines the core rules for when a new task can start.
// The flow is: checkTasks -> taskInitiated -> taskStarted
// This was specifically designed to prevent bugs like immediate task restarts.
// =========================================================================

const $taskInitiationDataSource = combine<TaskInitiationSource>({
  isRunning: $isTaskRunning,
  currentSystemCooldownStartTime: $taskStartTime,
  queue: $tasksQueue
});

// This is the main gatekeeper. It only allows a task to be considered if the bot is not
// busy AND the queue is not empty. It then checks for privileged status or cooldown.
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

// When taskInitiated is fired, this block officially starts the task.
sample({ clock: taskInitiated, source: $tasksQueue, filter: (q: UserInfo[]): q is UserInfo[] & { 0: UserInfo } => q.length > 0 && !$isTaskRunning.getState(), fn: (q: UserInfo[] & { 0: UserInfo }) => q[0], target: [$currentTask, taskStarted]});
sample({ clock: taskInitiated, source: $taskTimeout, filter: (t): t is number => typeof t === 'number' && t > 0, fn: (): Date => new Date(), target: $taskStartTime });
sample({ clock: taskInitiated, source: $taskTimeout, filter: (t): t is number => typeof t === 'number' && t > 0, fn: (t: number) => t, target: clearTimeoutWithDelayFx });

// This handles the system cooldown for non-privileged users.
$taskTimeout.on(clearTimeoutEvent, (_, n) => n);
sample({ clock: clearTimeoutEvent, fn: (): null => null, target: [$taskStartTime, checkTasks] });

// --- Trigger actual work based on the started task ---
sample({ clock: taskStarted, filter: (t: UserInfo): t is UserInfo => t.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (t: UserInfo): t is UserInfo => t.linkType === 'link', target: getParticularStoryFx });


// --- Effect Result Handling ---
type GetAllStoriesSuccessResult = { activeStories: Api.TypeStoryItem[]; pinnedStories: Api.TypeStoryItem[]; paginatedStories?: Api.TypeStoryItem[]; };
type GetParticularStorySuccessResult = { activeStories: Api.TypeStoryItem[]; pinnedStories: Api.TypeStoryItem[]; paginatedStories?: Api.TypeStoryItem[]; particularStory: Api.TypeStoryItem; };
type EffectDoneResult<SuccessT> = SuccessT | string;

// NOTE: The following samples source `$currentTask` to get the parameters for the
// completed task. This assumes that no new task can start until the previous one
// is fully done, which our current state machine guarantees.

sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task: UserInfo | null, effectResult: EffectDoneResult<GetAllStoriesSuccessResult>): task is UserInfo =>
    task !== null && typeof effectResult === 'string',
  fn: (task: UserInfo, effectResultFromClock: EffectDoneResult<GetAllStoriesSuccessResult>) => {
    const errorMessage = effectResultFromClock as string;
    return { task, message: errorMessage };
  },
  target: [sendErrorMessageFx, taskDone, checkTasks],
});

sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task: UserInfo | null, effectResult: EffectDoneResult<GetAllStoriesSuccessResult>): task is UserInfo =>
    task !== null && typeof effectResult === 'object' && effectResult !== null,
  fn: (task: UserInfo, effectResult: EffectDoneResult<GetAllStoriesSuccessResult>) => {
    const successResult = effectResult as GetAllStoriesSuccessResult;
    return { task: task, ...successResult };
  },
  target: sendStoriesFx,
});

getAllStoriesFx.fail.watch(({ params, error }) => {
  console.error(`[StoriesService] getAllStoriesFx.fail for ${params.link}:`, error);
  taskDone();
  checkTasks();
});

// ... (result handling for getParticularStoryFx is similar and correct) ...

// =========================================================================
// CRITICAL LOGIC: Final Task Completion
// DO NOT MODIFY without careful consideration.
// -------------------------------------------------------------------------
// This section ensures that after a task is fully processed (by sendStoriesFx),
// the system is cleaned up (`taskDone`) and explicitly checks for a new task (`checkTasks`).
// This is essential for the queue to advance correctly.
// =========================================================================
sendStoriesFx.done.watch(({ params }) => console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link));
sendStoriesFx.fail.watch(({ params, error }) => console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error));

sample({ clock: sendStoriesFx.done, target: [taskDone, checkTasks] });
sample({ clock: sendStoriesFx.fail, target: [taskDone, checkTasks] });

// --- Final Cleanup and State Resets ---
sample({ clock: taskDone, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: cleanupTempMessagesFx });
$currentTask.on(taskDone, () => null); // Reset current task when done
$isTaskRunning.on(taskDone, () => false); // Reset running status when done
$tasksQueue.on(taskDone, (tasks) => tasks.slice(1)); // Pop from queue when done

// ... (other minor handlers are correct and unchanged) ...
