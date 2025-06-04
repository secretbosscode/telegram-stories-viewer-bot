// stories-service.ts
import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';
import { createEffect, createEvent, createStore, sample } from 'effector';
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
const clearTimeout = createEvent<number>();
const $taskTimeout = createStore(isDevEnv ? 20_000 : 240_000);

const newTaskReceived = createEvent<UserInfo>();
const taskInitiated = createEvent();
const taskStarted = createEvent();
const tempMessageSent = createEvent<number>();
const taskDone = createEvent();
const checkTasks = createEvent();
const cleanUpTempMessagesFired = createEvent();

const timeoutList = isDevEnv ? [10_000, 15_000, 20_000] : [240_000, 300_000, 360_000];
const clearTimeoutWithDelayFx = createEffect((currentTimeout: number) => {
  const nextTimeout = getRandomArrayItem(timeoutList, currentTimeout);
  setTimeout(() => clearTimeout(nextTimeout), currentTimeout);
});

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

const sendWaitMessageFx = createEffect(async ({ multipleRequests, taskStartTime, taskTimeout, queueLength, newTask }: {
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
    await bot.telegram.sendMessage(newTask.chatId,
      `⏳ Please wait ***${timeToWait}*** before sending another link.\n\nYou can get ***unlimited access*** to our bot without waiting.\nRun the ***/premium*** command to upgrade.`,
      { parse_mode: 'Markdown' }
    );
  }
});

const cleanupTempMessagesFx = createEffect((task: UserInfo) => {
  task.tempMessages?.forEach(id => bot.telegram.deleteMessage(task.chatId, id));
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

sample({
  clock: newTaskReceived,
  filter: (task) => !task.nextStoriesIds,
  fn: (task) => task.user!,
  target: saveUserFx,
});

sample({
  clock: newTaskReceived,
  source: { currentTask: $currentTask, taskStartTime: $taskStartTime, taskTimeout: $taskTimeout, queue: $tasksQueue },
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

sample({ clock: checkTasks, filter: and(not($isTaskRunning), not($taskStartTime), $tasksQueue.map(q => q.length > 0)), target: taskInitiated });
sample({ clock: taskInitiated, source: $tasksQueue, fn: (tasks) => tasks[0], target: [$currentTask, taskStarted] });
sample({ clock: taskInitiated, fn: () => new Date(), target: $taskStartTime });
sample({ clock: taskInitiated, source: $taskTimeout, target: clearTimeoutWithDelayFx });
$taskTimeout.on(clearTimeout, (_, newTimeout) => newTimeout);
sample({ clock: clearTimeout, fn: () => null, target: [$taskStartTime, checkTasks] });

sample({ clock: taskStarted, source: $currentTask, filter: task => task?.linkType === 'link', target: getParticularStoryFx });
sample({ clock: taskStarted, source: $currentTask, filter: task => task?.linkType === 'username', target: getAllStoriesFx });

sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask,
  filter: (task, result) => typeof result === 'string',
  fn: (task, result) => ({ task: task!, message: result as string }),
  target: [sendErrorMessageFx, taskDone],
});

sample({
  clock: [getAllStoriesFx.doneData, getParticularStoryFx.doneData],
  source: $currentTask,
  filter: (task, result) => typeof result === 'object' && task !== null,
  fn: (task, result) => ({
    task: task!,
    ...(result as { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[] })
  }),
  target: sendStoriesFx,
});

sample({ clock: sendStoriesFx.done, target: taskDone });
sample({ clock: taskDone, source: $currentTask, filter: task => task !== null, target: cleanupTempMessagesFx });
sample({ clock: [newTaskReceived, taskDone], target: checkTasks });

$currentTask.on(tempMessageSent, (prev, msgId) => ({ ...prev!, tempMessages: [...(prev?.tempMessages ?? []), msgId] }));
$currentTask.on(cleanupTempMessagesFx.done, (prev) => ({ ...prev!, tempMessages: [] }));
$currentTask.on(taskDone, () => null);
sample({ clock: cleanUpTempMessagesFired, source: $currentTask, filter: task => task !== null, target: cleanupTempMessagesFx });

const intervalHasPassed = createEvent();
sample({ clock: intervalHasPassed, source: $currentTask, target: checkTaskForRestart });
setInterval(intervalHasPassed, 30_000);

export {
  tempMessageSent,
  cleanUpTempMessagesFired,
  newTaskReceived,
};

