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
const taskDone = createEvent<void>(); // Explicitly void if it takes no payload
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
        bot.telegram.deleteMessage(task.chatId, id).catch(() => null) // Gracefully handle errors if a message is already deleted
      )
    );
  }
});

const saveUserFx = createEffect(saveUser);

// ---- TASK QUEUE/SESSION HANDLING ----
$tasksQueue.on(newTaskReceived, (tasks, newTask) => {
  const isAdmin = newTask.chatId === BOT_ADMIN_ID.toString();
  const alreadyExist = tasks.some(x => x.chatId === newTask.chatId);
  const taskStartTime = $taskStartTime.getState(); // Get current state for comparison
  if ((isAdmin || newTask.isPremium) && !alreadyExist) return [newTask, ...tasks]; // Admins/Premium jump queue if not already there
  if (!alreadyExist && taskStartTime === null) return [...tasks, newTask]; // Add to queue if not present and no task is in cooldown
  return tasks; // Otherwise, don't modify queue (e.g., user already in queue or cooldown active)
});

$isTaskRunning.on(taskStarted, () => true).on(taskDone, () => false);
$tasksQueue.on(taskDone, (tasks) => tasks.slice(1)); // Remove completed task

// Only call saveUserFx if user exists
sample({
  clock: newTaskReceived,
  source: $taskSource, // Using the combined store
  filter: (sourceData, newTask) => !!sourceData.user, // Filter based on user presence in sourceData
  fn: (sourceData, newTask) => sourceData.user!, // Extract user from sourceData
  target: saveUserFx,
});

// Wait/cooldown logic for normal users
sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: ({ taskStartTime, queue, currentTask }, newTask) => { // Added currentTask to source for easier multiple request check
    const isAdmin = newTask.chatId === BOT_ADMIN_ID.toString();
    const isPrivileged = isAdmin || newTask.isPremium;
    // Check if the same user is trying to make a new request while their task is running OR general cooldown is active
    const isMultipleRequestFromCurrentUser = currentTask?.chatId === newTask.chatId && $isTaskRunning.getState();
    const isCooldownActive = taskStartTime instanceof Date || $isTaskRunning.getState();

    return !isPrivileged && (isCooldownActive || isMultipleRequestFromCurrentUser);
  },
  fn: ({ currentTask, taskStartTime, taskTimeout, queue }, newTask) => ({
    multipleRequests: currentTask?.chatId === newTask.chatId && $isTaskRunning.getState(), // If current running task is by same user
    taskStartTime,
    taskTimeout,
    queueLength: queue.filter(t => t.chatId !== newTask.chatId).length, // Queue length excluding the current new task if it's a duplicate warning
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
(sample as any)({ // Applied (as any) to bypass complex type error
  clock: getAllStoriesFx.done,
  filter: ({ result }: { result: any }) => typeof result === 'string',
  fn: ({ params, result }: { params: UserInfo, result: string }) => ({ task: params, message: result }),
  target: [sendErrorMessageFx, taskDone],
});

// Handle errors for getParticularStoryFx (return string)
(sample as any)({ // Applied (as any) to bypass complex type error
  clock: getParticularStoryFx.done,
  filter: ({ result }: { result: any }) => typeof result === 'string',
  fn: ({ params, result }: { params: UserInfo, result: string }) => ({ task: params, message: result }),
  target: [sendErrorMessageFx, taskDone],
});

// Handle successful result for getAllStoriesFx
sample({
  clock: getAllStoriesFx.done,
  filter: ({ result }: { result: any }) => typeof result === 'object', // Check if result is an object
  fn: ({ params, result }: { params: UserInfo, result: { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[] } }) => ({
    task: params,
    ...result
  }),
  target: sendStoriesFx,
});

// Handle successful result for getParticularStoryFx
sample({
  clock: getParticularStoryFx.done,
  filter: ({ result }: { result: any }) => typeof result === 'object', // Check if result is an object
  fn: ({ params, result }: { params: UserInfo, result: { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[], particularStory?: Api.TypeStoryItem } }) => ({
    task: params,
    ...result
  }),
  target: sendStoriesFx,
});

// After stories sent, finish task
(sample as any)({ clock: sendStoriesFx.done, target: taskDone }); // taskDone might need fn: () => {} if it expects void

(sample as any)({
  clock: taskDone,
  source: $currentTask,
  filter: (task: UserInfo | null): task is UserInfo => task !== null, // Type guard for filtering
  target: cleanupTempMessagesFx,
});
(sample as any)({
  clock: cleanUpTempMessagesFired,
  source: $currentTask,
  filter: (task: UserInfo | null): task is UserInfo => task !== null, // Type guard for filtering
  target: cleanupTempMessagesFx,
});

// Prevent error if no current task (null)
$currentTask.on(tempMessageSent, (prev, msgId) => {
  if (!prev) return prev;
  return { ...prev, tempMessages: [...(prev.tempMessages ?? []), msgId] };
});
$currentTask.on(cleanupTempMessagesFx.done, (prev) => {
  if (!prev) return prev;
  return { ...prev, tempMessages: [] }; // Clear temp messages
});
$currentTask.on(taskDone, () => null); // Reset current task

// Periodic watchdog: restart bot if task too slow (7 min+)
const intervalHasPassed = createEvent();
(sample as any)({ clock: intervalHasPassed, source: $currentTask, target: checkTaskForRestart });
setInterval(() => intervalHasPassed(), 30_000); // Check every 30 seconds

// ---- EXPORTS ----
export {
  tempMessageSent,
  cleanUpTempMessagesFired,
  newTaskReceived,
  checkTasks, // Export checkTasks to potentially trigger queue processing from outside
};
