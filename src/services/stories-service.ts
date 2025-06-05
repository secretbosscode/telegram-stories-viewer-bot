import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';
import { createEffect, createEvent, createStore, sample, combine, Event, StoreValue, EventCallable } from 'effector';
import { bot } from 'index';
import { getRandomArrayItem } from 'lib';
// import { and, not } from 'patronum'; // Not used, uncomment if needed
import { saveUser } from 'repositories/user-repository';
import { User } from 'telegraf/typings/core/types/typegram';
import { Api } from 'telegram';

// Console logs and watchers omitted for brevity in this corrected version, but you should keep them for debugging.

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

const timeoutList = isDevEnv ? [10000, 15000, 20000] : [240000, 300000, 360000];
const clearTimeoutWithDelayFx = createEffect((currentTimeout: number) => {
  setTimeout(() => clearTimeoutEvent(nextTimeout), currentTimeout);
  const nextTimeout = getRandomArrayItem(timeoutList, currentTimeout); // Moved after use for clarity
});

const MAX_WAIT_TIME = 7;
const LARGE_ITEM_THRESHOLD = 100;

const checkTaskForRestart = createEffect(async (task: UserInfo | null) => {
  if (task) {
    const minsFromStart = Math.floor((Date.now() - task.initTime) / 60000);
    if (minsFromStart >= MAX_WAIT_TIME) {
      const isPrivileged = task.chatId === BOT_ADMIN_ID.toString() || task.isPremium === true;
      if (isPrivileged) {
        console.warn(`[StoriesService] Admin/Premium task for ${task.link} (User: ${task.chatId}) running long.`);
        try {
          await bot.telegram.sendMessage(task.chatId, `🔔 Your long task for "${task.link}" is still running (${minsFromStart} mins).`).catch(() => {});
        } catch (e) { /* ignore */ }
      } else {
        console.error('[StoriesService] Task for non-privileged took too long, exiting:', task);
        await bot.telegram.sendMessage(BOT_ADMIN_ID, "❌ Task took too long (non-privileged):\n\n" + JSON.stringify(task, null, 2));
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
  const { multipleRequests, taskStartTime, taskTimeout, queueLength, newTask } = params;
  if (multipleRequests) {
    await bot.telegram.sendMessage(newTask.chatId, '⚠️ Only 1 link can be processed at once. Please wait.');
    return;
  }
  if (queueLength > 0) { // Check if queueLength > 0 for sending queue message
    await bot.telegram.sendMessage(newTask.chatId, `⏳ Please wait for your turn. ${queueLength} users ahead.`);
    return;
  }
  if (taskStartTime instanceof Date) {
    const remainingMs = taskStartTime.getTime() + taskTimeout - Date.now();
    if (remainingMs > 0) {
      const minutes = Math.floor(remainingMs / 60000);
      const seconds = Math.floor((remainingMs % 60000) / 1000);
      const timeToWait = minutes > 0 ? `${minutes} minute(s) and ${seconds} seconds` : `${seconds} seconds`;
      await bot.telegram.sendMessage(
        newTask.chatId,
        `⏳ Please wait ***${timeToWait}*** before sending another link.\n\nYou can get ***unlimited access*** by running /premium.`,
        { parse_mode: 'Markdown' }
      );
    }
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
    multipleRequests: ($isTaskRunning.getState() && sourceData.currentTask?.chatId !== newTask.chatId), // Corrected logic for multipleRequests
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
  clock: [checkTasks, $tasksQueue.updates.map((_: UserInfo[]) => undefined as void)],
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

sample({ clock: taskInitiated, source: $tasksQueue, filter: (q: UserInfo[]) => q.length > 0 && !$isTaskRunning.getState(), fn: (q: UserInfo[]) => q[0], target: [$currentTask, taskStarted]});
sample({ clock: taskInitiated, source: $taskTimeout, filter: Boolean, fn: (): Date => new Date(), target: $taskStartTime });
sample({ clock: taskInitiated, source: $taskTimeout, filter: Boolean, fn: (t: number) => t, target: clearTimeoutWithDelayFx });
$taskTimeout.on(clearTimeoutEvent, (_, n) => n);
sample({ clock: clearTimeoutEvent, fn: (): null => null, target: [$taskStartTime, checkTasks] });
sample({ clock: taskStarted, filter: (t: UserInfo) => t.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (t: UserInfo) => t.linkType === 'link', target: getParticularStoryFx });

// --- Effect Payload Success Types (assuming Api.TypeStoryItem is the correct type) ---
type GetAllStoriesSuccessResult = {
    activeStories: Api.TypeStoryItem[];
    pinnedStories: Api.TypeStoryItem[];
    paginatedStories?: Api.TypeStoryItem[];
};
type GetParticularStorySuccessResult = {
    activeStories: Api.TypeStoryItem[];
    pinnedStories: Api.TypeStoryItem[];
    paginatedStories?: Api.TypeStoryItem[];
    particularStory: Api.TypeStoryItem; // Should be non-optional if filter guarantees it
};

// Type for the `result` field of `doneData` payloads
type EffectResultType<SuccessT> = SuccessT | string;

// --- Handling getAllStoriesFx results ---
// This structure assumes getAllStoriesFx.doneData is effectively Event<EffectResultType<GetAllStoriesSuccessResult>>
// due to how TS is interpreting it in your environment.
// If getAllStoriesFx.doneData is truly Event<{params: UserInfo, result: ...}>, this needs to revert.
sample({
  clock: getAllStoriesFx.doneData.map(data => data.result), // Clock is now Event<actual result type>
  source: getAllStoriesFx.doneData.map(data => data.params), // Source provides params
  filter: (resultFromClock: EffectResultType<GetAllStoriesSuccessResult>): resultFromClock is string =>
    typeof resultFromClock === 'string',
  fn: (errorMessage: string, taskParams: UserInfo) => {
    return { task: taskParams, message: errorMessage };
  },
  target: [sendErrorMessageFx, taskDone],
});

sample({
  clock: getAllStoriesFx.doneData.map(data => data.result),
  source: getAllStoriesFx.doneData.map(data => data.params),
  filter: (resultFromClock: EffectResultType<GetAllStoriesSuccessResult>): resultFromClock is GetAllStoriesSuccessResult =>
    typeof resultFromClock === 'object' && resultFromClock !== null,
  fn: (successResult: GetAllStoriesSuccessResult, taskParams: UserInfo) => {
    const totalStories = (successResult.activeStories?.length || 0) + (successResult.pinnedStories?.length || 0) + (successResult.paginatedStories?.length || 0);
    if (totalStories > LARGE_ITEM_THRESHOLD && (taskParams.chatId === BOT_ADMIN_ID.toString() || taskParams.isPremium)) {
      bot.telegram.sendMessage(
        taskParams.chatId,
        `⏳ You're about to process ~${totalStories} story items for "${taskParams.link}". This might take a while...`
      ).then(msg => tempMessageSent(msg.message_id)).catch(e => console.error(`Failed to send long download warning:`, e));
    }
    return {
      task: taskParams,
      activeStories: successResult.activeStories || [],
      pinnedStories: successResult.pinnedStories || [],
      paginatedStories: successResult.paginatedStories,
      particularStory: undefined,
    };
  },
  target: sendStoriesFx,
});
getAllStoriesFx.fail.watch(({ params, error }) => console.error(`[StoriesService] getAllStoriesFx.fail for ${params.link}:`, error));

// --- Handling getParticularStoryFx results ---
sample({
  clock: getParticularStoryFx.doneData.map(data => data.result),
  source: getParticularStoryFx.doneData.map(data => data.params),
  filter: (resultFromClock: EffectResultType<GetParticularStorySuccessResult>): resultFromClock is string =>
    typeof resultFromClock === 'string',
  fn: (errorMessage: string, taskParams: UserInfo) => {
    return { task: taskParams, message: errorMessage };
  },
  target: [sendErrorMessageFx, taskDone],
});

sample({
  clock: getParticularStoryFx.doneData.map(data => data.result),
  source: getParticularStoryFx.doneData.map(data => data.params),
  filter: (resultFromClock: EffectResultType<GetParticularStorySuccessResult>): resultFromClock is GetParticularStorySuccessResult & { particularStory: Api.TypeStoryItem } =>
    typeof resultFromClock === 'object' &&
    resultFromClock !== null &&
    'particularStory' in resultFromClock && // Ensure particularStory key exists
    resultFromClock.particularStory !== undefined, // Ensure it's defined
  fn: (successResult: GetParticularStorySuccessResult & { particularStory: Api.TypeStoryItem }, taskParams: UserInfo) => {
    return {
      task: taskParams,
      activeStories: successResult.activeStories || [],
      pinnedStories: successResult.pinnedStories || [],
      paginatedStories: successResult.paginatedStories,
      particularStory: successResult.particularStory,
    };
  },
  target: sendStoriesFx,
});
getParticularStoryFx.fail.watch(({ params, error }) => console.error(`[StoriesService] getParticularStoryFx.fail for ${params.link}:`, error));

sendStoriesFx.done.watch(({ params }) => console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link));
sendStoriesFx.fail.watch(({ params, error }) => console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error));
sample({ clock: sendStoriesFx.done, target: taskDone });

sample({ clock: taskDone, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: cleanupTempMessagesFx });
sample({ clock: cleanUpTempMessagesFired, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: cleanupTempMessagesFx });

$currentTask.on(tempMessageSent, (prev, msgId) => {
  if (!prev) {
    return { chatId: '', link: '', linkType: 'username', locale: 'en', initTime: Date.now(), tempMessages: [msgId] } as UserInfo;
  }
  return { ...prev, tempMessages: [...(prev.tempMessages ?? []), msgId] };
});
$currentTask.on(cleanupTempMessagesFx.done, (prev) => prev ? { ...prev, tempMessages: [] } : null);
$currentTask.on(taskDone, () => null);

const intervalHasPassed = createEvent<void>();
sample({ clock: intervalHasPassed, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: checkTaskForRestart });
setInterval(() => intervalHasPassed(), 30_000);

export { tempMessageSent, cleanUpTempMessagesFired, newTaskReceived, checkTasks };
setTimeout(() => checkTasks(), 100);
