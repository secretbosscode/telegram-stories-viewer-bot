// stories-service.ts
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

// Stores & Events
const $currentTask = createStore<UserInfo | null>(null);
const $tasksQueue = createStore<UserInfo[]>([]);
const $isTaskRunning = createStore(false);
const $taskStartTime = createStore<Date | null>(null);
const clearTimeoutEvent = createEvent<number>();
const $taskTimeout = createStore(isDevEnv ? 20_000 : 240_000);

const newTaskReceived = createEvent<UserInfo>();
const taskInitiated = createEvent();
const taskStarted = createEvent();
const tempMessageSent = createEvent<number>();
const taskDone = createEvent();
const checkTasks = createEvent();
const cleanUpTempMessagesFired = createEvent();

// Timeout effect
const timeoutList = isDevEnv ? [10_000, 15_000, 20_000] : [240_000, 300_000, 360_000];
const clearTimeoutWithDelayFx = createEffect((currentTimeout: number) => {
  const nextTimeout = getRandomArrayItem(timeoutList, currentTimeout);
  setTimeout(() => clearTimeoutEvent(nextTimeout), currentTimeout);
});

// Task restart check
const MAX_WAIT_TIME = 7;
const checkTaskForRestart = createEffect(async (task: UserInfo | null) => {
  if (task) {
    const minsFromStart = Math.floor((Date.now() - task.initTime) / 60_000);
    if (minsFromStart === MAX_WAIT_TIME) {
      await bot.telegram.sendMessage(
        BOT_ADMIN_ID,
        "❌ Bot took too long to process a task:\n\n" + JSON.stringify(task, null, 2)
      );
    }
  }
});

// Combine task source values. Note: declared _before_ any sample call uses it.
const $taskSource = combine({
  currentTask: $currentTask,
  taskStartTime: $taskStartTime,
  taskTimeout: $taskTimeout,
  queue: $tasksQueue,
  // Derive a 'user' field from currentTask; this lets downstream code access it.
  user: $currentTask.map(task => task?.user ?? null)
});

// Effect to send a waiting message to the user
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

// Cleanup effect for temporary messages
const cleanupTempMessagesFx = createEffect((task: UserInfo) => {
  task.tempMessages?.forEach(id => bot.telegram.deleteMessage(task.chatId, id));
});

const saveUserFx = createEffect(saveUser);

// Queue management
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

// Save user effect – no "clock" property is used inside our fn object literal.
sample({
  clock: newTaskReceived,
  source: $taskSource,
  fn: (task) => task.user!,
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

// Send stories effects depending on link type
sample({
  clock: taskStarted,
  source: $currentTask,
  filter: task => task?.linkType === 'link',
  target: getParticularStoryFx,
});
sample({
  clock: taskStarted,
  source: $currentTask,
  filter: task => task?.linkType === 'username',
  target: getAllStoriesFx,
});

// Complete task on sending stories
sample({
  clock: sendStoriesFx.done,
  target: taskDone,
});

sample({
  clock: taskDone,
  source: $currentTask,
  filter: task => task !== null,
  target: cleanupTempMessagesFx,
});

sample({
  clock: cleanUpTempMessagesFired,
  source: $currentTask,
  filter: task => task !== null,
  target: cleanupTempMessagesFx,
});

export {
  tempMessageSent,
  cleanUpTempMessagesFired,
  newTaskReceived,
};
