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

// ---- DATA TYPES ----
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

// ---- STORES ----
const $currentTask = createStore<UserInfo | null>(null);
const $tasksQueue = createStore<UserInfo[]>([]);
const $isTaskRunning = createStore(false);
const $taskStartTime = createStore<Date | null>(null);
const clearTimeoutEvent = createEvent<number>();
const $taskTimeout = createStore(isDevEnv ? 20000 : 240000);

// ---- EVENTS ----
const newTaskReceived = createEvent<UserInfo>();
const taskInitiated = createEvent();
const taskStarted = createEvent();
const tempMessageSent = createEvent<number>();
const taskDone = createEvent();
const checkTasks = createEvent();
const cleanUpTempMessagesFired = createEvent();

// ---- UTILS ----
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
      process.exit();
    }
  }
});

// ---- TASK/USER QUEUE ----
const $taskSource = combine({
  currentTask: $currentTask,
  taskStartTime: $taskStartTime,
  taskTimeout: $taskTimeout,
  queue: $tasksQueue,
  user: $currentTask.map(task => task?.user ?? null),
});

// ---- WAIT MESSAGE ----
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

// ---- TEMP MESSAGE CLEANUP ----
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

// ---- TASK QUEUE/SESSION HANDLING ----
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

// Only call saveUserFx if user exists
sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: (taskSource, newTask) => !!taskSource.user,
  fn: (taskSource, newTask) => taskSource.user!,
  target: saveUserFx,
});

// Wait/cooldown logic for normal users
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

// Task queue advancement
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

// ----- MODERN EFFECTOR V22+: CORRECT EFFECT HANDLING -----
// Handle errors for getAllStoriesFx (return string)
sample({
  clock: getAllStoriesFx.done,
  filter: ({ result }) => typeof result === 'string',
  fn: ({ params, result }) => ({ task: params, message: result }),
  target: [sendErrorMessageFx, taskDone],
});
sample({
  clock: getParticularStoryFx.done,
  filter: ({ result }) => typeof result === 'string',
  fn: ({ params, result }) => ({ task: params, message: result }),
  target: [sendErrorMessageFx, taskDone],
});
// Handle successful result for getAllStoriesFx
sample({
  clock: getAllStoriesFx.done,
  filter: ({ result }) => typeof result === 'object',
  fn: ({ params, result }) => ({
    task: params,
    ...(result as { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[] })
  }),
  target: sendStoriesFx,
});
// Handle successful result for getParticularStoryFx
sample({
  clock: getParticularStoryFx.done,
  filter: ({ result }) => typeof result === 'object',
  fn: ({ params, result }) => ({
    task: params,
    ...(result as { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[], particularStory?: Api.TypeStoryItem })
  }),
  target: sendStoriesFx,
});
// After stories sent, finish task
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

// Prevent error if no current task (null)
$currentTask.on(tempMessageSent, (prev, msgId) => {
  if (!prev) return prev;
  return { ...prev, tempMessages: [...(prev.tempMessages ?? []), msgId] };
});
$currentTask.on(cleanupTempMessagesFx.done, (prev) => {
  if (!prev) return prev;
  return { ...prev, tempMessages: [] };
});
$currentTask.on(taskDone, () => null);

// Periodic watchdog: restart bot if task too slow (7 min+)
const intervalHasPassed = createEvent();
(sample as any)({ clock: intervalHasPassed, source: $currentTask, target: checkTaskForRestart });
setInterval(() => intervalHasPassed(), 30_000);

// ---- EXPORTS ----
export {
  tempMessageSent,
  cleanUpTempMessagesFired,
  newTaskReceived,
};
