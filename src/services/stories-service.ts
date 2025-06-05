import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';
import { createEffect, createEvent, createStore, sample, combine, Event, StoreValue, EventCallable } from 'effector';
import { bot } from 'index';
import { getRandomArrayItem } from 'lib';
// import { and, not } from 'patronum'; // Not used in the latest snippet, uncomment if needed
import { saveUser } from 'repositories/user-repository';
import { User } from 'telegraf/typings/core/types/typegram';
import { Api } from 'telegram';

console.log('[StoriesService] sendStoriesFx.kind:', sendStoriesFx.kind);

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

// --- Watchers for debugging (omitted for brevity in this correction, keep them if you need them) ---

const timeoutList = isDevEnv ? [10000, 15000, 20000] : [240000, 300000, 360000];
const clearTimeoutWithDelayFx = createEffect((currentTimeout: number) => {
  console.log('[StoriesService] clearTimeoutWithDelayFx called with timeout:', currentTimeout);
  const nextTimeout = getRandomArrayItem(timeoutList, currentTimeout);
  setTimeout(() => clearTimeoutEvent(nextTimeout), currentTimeout);
});

const MAX_WAIT_TIME = 7;
const LARGE_ITEM_THRESHOLD = 100;

const checkTaskForRestart = createEffect(async (task: UserInfo | null) => {
  if (task) {
    const minsFromStart = Math.floor((Date.now() - task.initTime) / 60000);
    console.log(`[StoriesService] checkTaskForRestart: Task for ${task.link} (User: ${task.chatId}), ${minsFromStart} mins from start.`);
    if (minsFromStart >= MAX_WAIT_TIME) {
      const isAdmin = task.chatId === BOT_ADMIN_ID.toString();
      const isPremiumUser = task.isPremium === true;
      if (isAdmin || isPremiumUser) {
        console.warn(`[StoriesService] Admin/Premium task for ${task.link} (User: ${task.chatId}) has been running for ${minsFromStart} minutes. Allowing to continue.`);
        try {
          await bot.telegram.sendMessage(task.chatId, `🔔 Your long task for "${task.link}" is still running (${minsFromStart} mins).`).catch(e => {});
        } catch (e) {
          console.error(`[StoriesService] Failed to send long task notification:`, e);
        }
      } else {
        console.error('[StoriesService] Task for non-admin/premium took too long, exiting:', JSON.stringify(task));
        await bot.telegram.sendMessage(
          BOT_ADMIN_ID,
          "❌ Bot took too long to process a task (non-admin/premium) and was shut down:\n\n" + JSON.stringify(task, null, 2)
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
  if (queueLength) {
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
        `⏳ Please wait ***${timeToWait}*** before sending another link.\n\nYou can get ***unlimited access*** to our bot without waiting.\nRun the ***/premium*** command to upgrade.`,
        { parse_mode: 'Markdown' }
      );
    }
  }
});

const cleanupTempMessagesFx = createEffect(async (task: UserInfo) => {
  if (task.tempMessages && task.tempMessages.length > 0) {
    await Promise.allSettled(
      task.tempMessages.map(id =>
        bot.telegram.deleteMessage(task.chatId, id).catch((err) => {
          console.warn(`[StoriesService] Failed to delete temp message ${id} for chat ${task.chatId}:`, err.message);
          return null;
        })
      )
    );
  }
});

const saveUserFx = createEffect(saveUser);

$tasksQueue.on(newTaskReceived, (tasks, newTask) => {
  const isAdmin = newTask.chatId === BOT_ADMIN_ID.toString();
  const isPremiumUser = newTask.isPremium === true;
  const alreadyExist = tasks.some(x => x.chatId === newTask.chatId && x.link === newTask.link);
  if (alreadyExist) return tasks;
  if (isAdmin || isPremiumUser) return [newTask, ...tasks];
  return [...tasks, newTask];
});

$isTaskRunning.on(taskStarted, () => true).on(taskDone, () => false);
$tasksQueue.on(taskDone, (tasks) => tasks.length > 0 ? tasks.slice(1) : []);

sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: (sourceData: TaskSourceSnapshot): sourceData is TaskSourceSnapshot & { user: User } => !!sourceData.user,
  fn: (sourceData: TaskSourceSnapshot & { user: User }): User => sourceData.user, // newTask is implicitly passed if not used
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
    multipleRequests: false, // This logic seems to always be false based on filter, review if needed
    taskStartTime: sourceData.taskStartTime,
    taskTimeout: sourceData.taskTimeout,
    queueLength: sourceData.queue.filter(t => t.chatId !== newTask.chatId && t.link !== newTask.link).length,
    newTask,
  }),
  target: sendWaitMessageFx,
});

type TaskInitiationSource = {
  isRunning: boolean;
  currentSystemCooldownStartTime: Date | null;
  queue: UserInfo[];
};
const $taskInitiationDataSource = combine<TaskInitiationSource>({
  isRunning: $isTaskRunning,
  currentSystemCooldownStartTime: $taskStartTime,
  queue: $tasksQueue
});

sample({
  clock: [checkTasks, $tasksQueue.updates.map((_: UserInfo[]) => undefined as void)],
  source: $taskInitiationDataSource,
  filter: (sourceValues: TaskInitiationSource): boolean => {
    const { isRunning, currentSystemCooldownStartTime, queue } = sourceValues;
    if (isRunning || queue.length === 0) return false;
    const nextTaskInQueue = queue[0];
    if (!nextTaskInQueue) return false;
    const isPrivileged = nextTaskInQueue.chatId === BOT_ADMIN_ID.toString() || nextTaskInQueue.isPremium === true;
    return isPrivileged || currentSystemCooldownStartTime === null;
  },
  target: taskInitiated,
});

sample({
  clock: taskInitiated,
  source: $tasksQueue,
  filter: (queue: UserInfo[]): boolean => queue.length > 0 && !$isTaskRunning.getState(),
  fn: (tasks: UserInfo[]): UserInfo => tasks[0],
  target: [$currentTask, taskStarted],
});

sample({ clock: taskInitiated, source: $taskTimeout, filter: Boolean, fn: (): Date => new Date(), target: $taskStartTime });
sample({ clock: taskInitiated, source: $taskTimeout, filter: Boolean, fn: (timeout: number) => timeout, target: clearTimeoutWithDelayFx });

$taskTimeout.on(clearTimeoutEvent, (_, newTimeout) => newTimeout);

sample({ clock: clearTimeoutEvent, fn: (): null => null, target: [$taskStartTime, checkTasks] });

sample({ clock: taskStarted, filter: (task: UserInfo): boolean => task.linkType === 'username', target: getAllStoriesFx });
sample({ clock: taskStarted, filter: (task: UserInfo): boolean => task.linkType === 'link', target: getParticularStoryFx });

// CORRECTED: Manual type definitions for effect payloads
// These assume your effects getAllStoriesFx and getParticularStoryFx are typed (or intended to be typed)
// such that their .doneData event payloads match these structures.
// If these effects actually produce `never` or incompatible types, those effect definitions MUST be fixed.
type GetAllStoriesSuccessResult = {
    activeStories: Api.TypeStoryItem[];
    pinnedStories: Api.TypeStoryItem[];
    paginatedStories?: Api.TypeStoryItem[];
};
export type GetAllStoriesDonePayload = { params: UserInfo, result: GetAllStoriesSuccessResult | string };

type GetParticularStorySuccessResult = {
    activeStories: Api.TypeStoryItem[]; // Assuming these are part of the result even for a particular story
    pinnedStories: Api.TypeStoryItem[]; // If not, adjust this type
    paginatedStories?: Api.TypeStoryItem[];
    particularStory: Api.TypeStoryItem; // Made non-optional as filter will check for it
};
export type GetParticularStoryDonePayload = { params: UserInfo, result: GetParticularStorySuccessResult | string };


// Handling getAllStoriesFx results
sample({
  clock: getAllStoriesFx.doneData,
  filter: (payload: GetAllStoriesDonePayload): payload is { params: UserInfo; result: string } =>
    typeof payload.result === 'string',
  fn: ({ params, result }: { params: UserInfo; result: string }) => ({ task: params, message: result }),
  target: [sendErrorMessageFx, taskDone],
});

sample({
  clock: getAllStoriesFx.doneData,
  filter: (payload: GetAllStoriesDonePayload): payload is { params: UserInfo; result: GetAllStoriesSuccessResult } =>
    typeof payload.result === 'object' && payload.result !== null,
  fn: (payload: { params: UserInfo; result: GetAllStoriesSuccessResult }) => {
    const { params: taskFromGetAll, result: resultFromGetAll } = payload;
    const totalStories = (resultFromGetAll.activeStories?.length || 0) + (resultFromGetAll.pinnedStories?.length || 0) + (resultFromGetAll.paginatedStories?.length || 0);
    if (totalStories > LARGE_ITEM_THRESHOLD && (taskFromGetAll.chatId === BOT_ADMIN_ID.toString() || taskFromGetAll.isPremium)) {
      bot.telegram.sendMessage(
        taskFromGetAll.chatId,
        `⏳ You're about to process ~${totalStories} story items for "${taskFromGetAll.link}". This might take a while...`
      ).then(msg => tempMessageSent(msg.message_id)).catch(e => console.error(`Failed to send long download warning:`, e));
    }
    return {
      task: taskFromGetAll,
      activeStories: resultFromGetAll.activeStories || [],
      pinnedStories: resultFromGetAll.pinnedStories || [],
      paginatedStories: resultFromGetAll.paginatedStories,
      particularStory: undefined,
    };
  },
  target: sendStoriesFx,
});
getAllStoriesFx.fail.watch(({ params, error }) => console.error(`[StoriesService] getAllStoriesFx.fail for ${params.link}:`, error));


// Handling getParticularStoryFx results
sample({
  clock: getParticularStoryFx.doneData,
  filter: (payload: GetParticularStoryDonePayload): payload is { params: UserInfo; result: string } =>
    typeof payload.result === 'string',
  fn: ({ params, result }: { params: UserInfo; result: string }) => ({ task: params, message: result }),
  target: [sendErrorMessageFx, taskDone],
});

sample({
  clock: getParticularStoryFx.doneData,
  filter: (payload: GetParticularStoryDonePayload): payload is { params: UserInfo; result: GetParticularStorySuccessResult } =>
    typeof payload.result === 'object' &&
    payload.result !== null &&
    'particularStory' in payload.result && // Ensure particularStory exists
    payload.result.particularStory !== undefined,
  fn: (payload: { params: UserInfo; result: GetParticularStorySuccessResult }) => {
    const { params: taskFromGetParticular, result: resultFromGetParticular } = payload;
    return {
      task: taskFromGetParticular,
      activeStories: resultFromGetParticular.activeStories || [],
      pinnedStories: resultFromGetParticular.pinnedStories || [],
      paginatedStories: resultFromGetParticular.paginatedStories,
      particularStory: resultFromGetParticular.particularStory, // Now correctly typed due to filter
    };
  },
  target: sendStoriesFx,
});
getParticularStoryFx.fail.watch(({ params, error }) => console.error(`[StoriesService] getParticularStoryFx.fail for ${params.link}:`, error));


// Watchers for sendStoriesFx (simplified for clarity, adjust as needed)
sendStoriesFx.done.watch(({ params }) => {
  console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link);
});
sendStoriesFx.fail.watch(({ params, error }) => {
  console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error);
});

sample({ clock: sendStoriesFx.done, target: taskDone });

sample({ clock: taskDone, source: $currentTask, filter: (task): task is UserInfo => task !== null, target: cleanupTempMessagesFx });
sample({ clock: cleanUpTempMessagesFired, source: $currentTask, filter: (task): task is UserInfo => task !== null, target: cleanupTempMessagesFx });

$currentTask.on(tempMessageSent, (prev, msgId) => {
  if (!prev) {
    console.warn("[StoriesService] $currentTask was null when tempMessageSent called.");
    // This minimal UserInfo might not be sufficient depending on how UserInfo is used elsewhere.
    return { chatId: '', link: '', linkType: 'username', locale: 'en', initTime: Date.now(), tempMessages: [msgId] } as UserInfo;
  }
  return { ...prev, tempMessages: [...(prev.tempMessages ?? []), msgId] };
});
$currentTask.on(cleanupTempMessagesFx.done, (prev) => prev ? { ...prev, tempMessages: [] } : null);
$currentTask.on(taskDone, () => null);

const intervalHasPassed = createEvent<void>();
sample({ clock: intervalHasPassed, source: $currentTask, filter: (task): task is UserInfo => task !== null, target: checkTaskForRestart });
setInterval(() => intervalHasPassed(), 30_000);

export { tempMessageSent, cleanUpTempMessagesFired, newTaskReceived, checkTasks };
setTimeout(() => checkTasks(), 100);
