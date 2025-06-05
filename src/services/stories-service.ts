import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';
import { createEffect, createEvent, createStore, sample, combine, Event, StoreValue, EventCallable } from 'effector';
import { bot } from 'index';
import { getRandomArrayItem } from 'lib';
// import { and, not } from 'patronum'; // Not used in current version
import { saveUser } from 'repositories/user-repository';
import { User } from 'telegraf/typings/core/types/typegram';
import { Api } from 'telegram';

// Console logs and most watchers omitted for brevity, please retain them for your debugging.

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
  const { multipleRequests, taskStartTime, taskTimeout, queueLength, newTask } = params;
  if (multipleRequests) {
    await bot.telegram.sendMessage(newTask.chatId, '⚠️ Only 1 link can be processed at once. Please wait.');
    return;
  }
  if (queueLength > 0) {
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

sample({ clock: taskInitiated, source: $tasksQueue, filter: (q: UserInfo[]): q is UserInfo[] & { 0: UserInfo } => q.length > 0 && !$isTaskRunning.getState(), fn: (q: UserInfo[] & { 0: UserInfo }) => q[0], target: [$currentTask, taskStarted]});
sample({ clock: taskInitiated, source: $taskTimeout, filter: (t): t is number => typeof t === 'number' && t > 0, fn: (): Date => new Date(), target: $taskStartTime });
sample({ clock: taskInitiated, source: $taskTimeout, filter: (t): t is number => typeof t === 'number' && t > 0, fn: (t: number) => t, target: clearTimeoutWithDelayFx });
$taskTimeout.on(clearTimeoutEvent, (_, n) => n);
sample({ clock: clearTimeoutEvent, fn: (): null => null, target: [$taskStartTime, checkTasks] });
sample({ clock: taskStarted, filter: (t: UserInfo): t is UserInfo => t.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (t: UserInfo): t is UserInfo => t.linkType === 'link', target: getParticularStoryFx });


// --- Effect Payload Success Types ---
type GetAllStoriesSuccessResult = {
    activeStories: Api.TypeStoryItem[];
    pinnedStories: Api.TypeStoryItem[];
    paginatedStories?: Api.TypeStoryItem[];
};

type GetParticularStorySuccessResult = {
    activeStories: Api.TypeStoryItem[];
    pinnedStories: Api.TypeStoryItem[];
    paginatedStories?: Api.TypeStoryItem[];
    particularStory: Api.TypeStoryItem;
};

// This type represents what your effect's .doneData payload's `result` field contains
// (or what effect.doneData itself contains, based on TS errors).
type EffectDoneResult<SuccessT> = SuccessT | string;

// --- Handling getAllStoriesFx results ---
sample({
  clock: getAllStoriesFx.doneData, // Assumed by TS to be Event<EffectDoneResult<GetAllStoriesSuccessResult>>
  source: $currentTask,
  filter: (task: UserInfo | null, effectResult: EffectDoneResult<GetAllStoriesSuccessResult>): task is UserInfo =>
    task !== null && typeof effectResult === 'string',
  // CORRECTED: fn's second parameter now accepts the wider type from the clock
  fn: (task: UserInfo, effectResultFromClock: EffectDoneResult<GetAllStoriesSuccessResult>) => {
    // We know effectResultFromClock is a string here due to the filter.
    const errorMessage = effectResultFromClock as string;
    console.log('[StoriesService] getAllStoriesFx.doneData (error path) - task:', task.link, 'Message:', errorMessage);
    return { task, message: errorMessage };
  },
  target: [sendErrorMessageFx, taskDone],
});

sample({
  clock: getAllStoriesFx.doneData,
  source: $currentTask,
  filter: (task: UserInfo | null, effectResult: EffectDoneResult<GetAllStoriesSuccessResult>): task is UserInfo =>
    task !== null && typeof effectResult === 'object' && effectResult !== null,
  fn: (task: UserInfo, effectResult: EffectDoneResult<GetAllStoriesSuccessResult>) => {
    const successResult = effectResult as GetAllStoriesSuccessResult; // Safe due to filter
    console.log('[StoriesService] getAllStoriesFx.doneData (success path) - task:', task.link);

    const totalStories = (successResult.activeStories?.length || 0) + (successResult.pinnedStories?.length || 0) + (successResult.paginatedStories?.length || 0);
    if (totalStories > LARGE_ITEM_THRESHOLD && (task.chatId === BOT_ADMIN_ID.toString() || task.isPremium)) {
      bot.telegram.sendMessage(
        task.chatId,
        `⏳ You're about to process ~${totalStories} story items for "${task.link}". This might take a while...`
      ).then(msg => tempMessageSent(msg.message_id)).catch(e => console.error(`Failed to send long download warning:`, e));
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
getAllStoriesFx.fail.watch(({ params, error }) => console.error(`[StoriesService] getAllStoriesFx.fail for ${params.link}:`, error));


// --- Handling getParticularStoryFx results ---
sample({
  clock: getParticularStoryFx.doneData,
  source: $currentTask,
  filter: (task: UserInfo | null, effectResult: EffectDoneResult<GetParticularStorySuccessResult>): task is UserInfo =>
    task !== null && typeof effectResult === 'string',
  // CORRECTED: fn's second parameter now accepts the wider type from the clock
  fn: (task: UserInfo, effectResultFromClock: EffectDoneResult<GetParticularStorySuccessResult>) => {
    // We know effectResultFromClock is a string here due to the filter.
    const errorMessage = effectResultFromClock as string;
    console.log('[StoriesService] getParticularStoryFx.doneData (error path) - task:', task.link, 'Message:', errorMessage);
    return { task, message: errorMessage };
  },
  target: [sendErrorMessageFx, taskDone],
});

sample({
  clock: getParticularStoryFx.doneData,
  source: $currentTask,
  filter: (task: UserInfo | null, effectResult: EffectDoneResult<GetParticularStorySuccessResult>): task is UserInfo =>
    task !== null &&
    typeof effectResult === 'object' &&
    effectResult !== null &&
    'particularStory' in effectResult &&
    (effectResult as GetParticularStorySuccessResult).particularStory !== undefined,
  fn: (task: UserInfo, effectResult: EffectDoneResult<GetParticularStorySuccessResult>) => {
    const successResult = effectResult as GetParticularStorySuccessResult & { particularStory: Api.TypeStoryItem }; // Safe due to filter
    console.log('[StoriesService] getParticularStoryFx.doneData (success path) - task:', task.link);
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
getParticularStoryFx.fail.watch(({ params, error }) => console.error(`[StoriesService] getParticularStoryFx.fail for ${params.link}:`, error));

sendStoriesFx.done.watch(({ params }) => { // Assuming sendStoriesFx.done provides { params: { task: UserInfo } }
  console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link);
});
sendStoriesFx.fail.watch(({ params, error }) => { // Assuming sendStoriesFx.fail provides { params: { task: UserInfo }, error: any }
  console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error);
});

sample({ clock: sendStoriesFx.done, target: taskDone });

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

const intervalHasPassed = createEvent<void>();
sample({ clock: intervalHasPassed, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: checkTaskForRestart });
setInterval(() => intervalHasPassed(), 30_000);

export { tempMessageSent, cleanUpTempMessagesFired, newTaskReceived, checkTasks };
setTimeout(() => checkTasks(), 100);
