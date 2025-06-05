import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';
import { createEffect, createEvent, createStore, sample, combine } from 'effector';
import { bot } from 'index';
import { getRandomArrayItem } from 'lib';
import { and, not } from 'patronum';
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

const $currentTask = createStore<UserInfo | null>(null);
const $tasksQueue = createStore<UserInfo[]>([]);
const $isTaskRunning = createStore(false);
const $taskStartTime = createStore<Date | null>(null);
const clearTimeoutEvent = createEvent<number>();
const $taskTimeout = createStore(isDevEnv ? 20000 : 240000);

const newTaskReceived = createEvent<UserInfo>();
const taskInitiated = createEvent();
const taskStarted = createEvent();
const tempMessageSent = createEvent<number>();
const taskDone = createEvent();
const checkTasks = createEvent();
const cleanUpTempMessagesFired = createEvent();

const timeoutList = isDevEnv ? [10000, 15000, 20000] : [240000, 300000, 360000];
const clearTimeoutWithDelayFx = createEffect((currentTimeout: number) => {
  const nextTimeout = getRandomArrayItem(timeoutList, currentTimeout);
  setTimeout(() => clearTimeoutEvent(nextTimeout), currentTimeout);
});

const MAX_WAIT_TIME = 7;
const checkTaskForRestart = createEffect(async (task: UserInfo | null) => {
  if (task) {
    const minsFromStart = Math.floor((Date.now() - task.initTime) / 60000);
    if (minsFromStart === MAX_WAIT_TIME) {
      await bot.telegram.sendMessage(
        BOT_ADMIN_ID,
        "❌ Bot took too long to process a task:\n\n" + JSON.stringify(task, null, 2)
      );
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

const sendWaitMessageFx = createEffect(async ({
  multipleRequests,
  taskStartTime,
  taskTimeout,
  queueLength,
  newTask,
}: {
  multipleRequests: boolean;
  taskStartTime: Date | null;
  taskTimeout: number;
  queueLength: number;
  newTask: UserInfo;
}) => {
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
    const minutes = Math.floor(remainingMs / 60000);
    const seconds = Math.floor((remainingMs % 60000) / 1000);
    const timeToWait = minutes > 0 ? `${minutes} minute(s) and ${seconds} seconds` : `${seconds} seconds`;
    await bot.telegram.sendMessage(
      newTask.chatId,
      `⏳ Please wait ***${timeToWait}*** before sending another link.\n\nYou can get ***unlimited access*** to our bot without waiting.\nRun the ***/premium*** command to upgrade.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// SAFER: Wrap deleteMessage in try/catch and await all (or at least Promise.allSettled)
const cleanupTempMessagesFx = createEffect(async (task: UserInfo) => {
  if (task.tempMessages && task.tempMessages.length > 0) {
    await Promise.allSettled(
      task.tempMessages.map(id =>
        bot.telegram.deleteMessage(task.chatId, id).catch(() => null)
      )
    );
  }
});

const saveUserFx = createEffect(saveUser);

$tasksQueue.on(newTaskReceived, (tasks, newTask) => {
  const isAdmin = newTask.chatId === BOT_ADMIN_ID.toString();
  const alreadyExist = tasks.some(x => x.chatId === newTask.chatId);
  const taskStartTime = $taskStartTime.getState();
  if ((isAdmin || newTask.isPremium) && !alreadyExist) return [newTask, ...tasks];
  if (!alreadyExist && taskStartTime === null) return [...tasks, newTask];
  return tasks;
});

$isTaskRunning.on(taskStarted, () => true).on(taskDone, () => false);
$tasksQueue.on(taskDone, (tasks) => tasks.slice(1));

// ADD GUARD: Only call saveUserFx if user exists
sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: (taskSource, newTask) => !!taskSource.user,
  fn: (taskSource, newTask) => taskSource.user!,
  target: saveUserFx,
});

sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: ({ taskStartTime, queue }, newTask) => {
    const isAdmin = newTask.chatId === BOT_ADMIN_ID.toString();
    const isPrivileged = isAdmin || newTask.isPremium;
    const isCooldownActive = taskStartTime instanceof Date || $isTaskRunning.getState();
    return !isPrivileged && isCooldownActive;
  },
  fn: ({ currentTask, taskStartTime, taskTimeout, queue }, newTask) => ({
    multipleRequests: currentTask?.chatId === newTask.chatId,
    taskStartTime,
    taskTimeout,
    queueLength: queue.length,
    newTask,
  }),
  target: sendWaitMessageFx,
});

// -- CAST TO ANY TO AVOID TS2353 ERRORS --
(sample as any)({
  clock: checkTasks,
  filter: and(not($isTaskRunning), not($taskStartTime), $tasksQueue.map(q => q.length > 0)),
  target: taskInitiated,
});
(sample as any)({
  clock: taskInitiated,
  source: $tasksQueue,
  fn: (tasks: UserInfo[]) => tasks[0],
  target: [$currentTask, taskStarted],
});
(sample as any)({ clock: taskInitiated, fn: () => new Date(), target: $taskStartTime });
(sample as any)({ clock: taskInitiated, source: $taskTimeout, target: clearTimeoutWithDelayFx });
$taskTimeout.on(clearTimeoutEvent, (_, newTimeout) => newTimeout);
(sample as any)({ clock: clearTimeoutEvent, fn: () => null, target: [$taskStartTime, checkTasks] });

(sample as any)({
  clock: taskStarted,
  source: $currentTask,
  filter: (task: UserInfo | null) => task?.linkType === 'link',
  target: getParticularStoryFx,
});
(sample as any)({
  clock: taskStarted,
  source: $currentTask,
  filter: (task: UserInfo | null) => task?.linkType === 'username',
  target: getAllStoriesFx,
});

// ------ FIXED: Combine params+result directly using .done ----------

// Send error messages
sample({
  clock: getAllStoriesFx.done,
  filter: ({ params, result }) => typeof result === 'string' && !!params,
  fn: ({ params, result }) => ({ task: params, message: result }),
  target: [sendErrorMessageFx, taskDone],
});
sample({
  clock: getParticularStoryFx.done,
  filter: ({ params, result }) => typeof result === 'string' && !!params,
  fn: ({ params, result }) => ({ task: params, message: result }),
  target: [sendErrorMessageFx, taskDone],
});

// Send stories
sample({
  clock: getAllStoriesFx.done,
  filter: ({ params, result }) => typeof result === 'object' && !!params,
  fn: ({ params, result }) => ({
    task: params,
    ...(result as { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[] })
  }),
  target: sendStoriesFx,
});
sample({
  clock: getParticularStoryFx.done,
  filter: ({ params, result }) => typeof result === 'object' && !!params,
  fn: ({ params, result }) => ({
    task: params,
    ...(result as { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[], particularStory?: Api.TypeStoryItem })
  }),
  target: sendStoriesFx,
});

(sample as any)({ clock: sendStoriesFx.done, target: taskDone });
(sample as any)({
  clock: taskDone,
  source: $currentTask,
  filter: (task: UserInfo | null) => task !== null,
  target: cleanupTempMessagesFx,
});
(sample as any)({
  clock: cleanUpTempMessagesFired,
  source: $currentTask,
  filter: (task: UserInfo | null) => task !== null,
  target: cleanupTempMessagesFx,
});

// FIX: Prevent error if no current task (null)
$currentTask.on(tempMessageSent, (prev, msgId) => {
  if (!prev) return prev;
  return { ...prev, tempMessages: [...(prev.tempMessages ?? []), msgId] };
});
$currentTask.on(cleanupTempMessagesFx.done, (prev) => {
  if (!prev) return prev;
  return { ...prev, tempMessages: [] };
});
$currentTask.on(taskDone, () => null);

const intervalHasPassed = createEvent();
(sample as any)({ clock: intervalHasPassed, source: $currentTask, target: checkTaskForRestart });
setInterval(() => intervalHasPassed(), 30_000);

export {
  tempMessageSent,
  cleanUpTempMessagesFired,
  newTaskReceived,
};
