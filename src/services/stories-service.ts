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
const taskStarted = createEvent(); // This event signifies a task is ready to be processed
const tempMessageSent = createEvent<number>();
const taskDone = createEvent<void>(); // Explicitly void if it takes no payload
const checkTasks = createEvent();
const cleanUpTempMessagesFired = createEvent();

// ---- LOGGING ----
newTaskReceived.watch(task => console.log('[StoriesService] newTaskReceived:', JSON.stringify(task)));
taskInitiated.watch(() => console.log('[StoriesService] taskInitiated called.'));
taskStarted.watch(() => console.log('[StoriesService] taskStarted called. Current task should be set.'));
$currentTask.updates.watch(task => console.log('[StoriesService] $currentTask updated:', JSON.stringify(task)));
checkTasks.watch(() => console.log('[StoriesService] checkTasks event called.'));
$tasksQueue.updates.watch(queue => console.log('[StoriesService] $tasksQueue updated. Length:', queue.length, 'Links:', queue.map(t => t.link)));


// ---- UTILS ----
const timeoutList = isDevEnv ? [10000, 15000, 20000] : [240000, 300000, 360000];
const clearTimeoutWithDelayFx = createEffect((currentTimeout: number) => {
  console.log('[StoriesService] clearTimeoutWithDelayFx called with timeout:', currentTimeout);
  const nextTimeout = getRandomArrayItem(timeoutList, currentTimeout);
  setTimeout(() => clearTimeoutEvent(nextTimeout), currentTimeout);
});

const MAX_WAIT_TIME = 7;
const checkTaskForRestart = createEffect(async (task: UserInfo | null) => {
  if (task) {
    const minsFromStart = Math.floor((Date.now() - task.initTime) / 60000);
    console.log(`[StoriesService] checkTaskForRestart: Task ${task.link}, ${minsFromStart} mins from start.`);
    if (minsFromStart === MAX_WAIT_TIME) {
      console.error('[StoriesService] Task took too long, exiting:', JSON.stringify(task));
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
const sendWaitMessageFx = createEffect(async (params: {
  multipleRequests: boolean;
  taskStartTime: Date | null;
  taskTimeout: number;
  queueLength: number;
  newTask: UserInfo;
}) => {
  const { multipleRequests, taskStartTime, taskTimeout, queueLength, newTask } = params;
  console.log('[StoriesService] sendWaitMessageFx called for:', newTask.link, 'Params:', JSON.stringify(params));
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
  console.log('[StoriesService] cleanupTempMessagesFx called for task:', task.link);
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
saveUserFx.done.watch(({params}) => console.log('[StoriesService] saveUserFx.done for user:', params?.id));
saveUserFx.fail.watch(({params, error}) => console.error('[StoriesService] saveUserFx.fail for user:', params?.id, 'Error:', error));


// ---- TASK QUEUE/SESSION HANDLING ----
$tasksQueue.on(newTaskReceived, (tasks, newTask) => {
  console.log('[StoriesService] $tasksQueue.on(newTaskReceived) - current queue length:', tasks.length, 'new task:', newTask.link);
  const isAdmin = newTask.chatId === BOT_ADMIN_ID.toString();
  const alreadyExist = tasks.some(x => x.chatId === newTask.chatId && x.link === newTask.link); // More specific check
  const taskStartTime = $taskStartTime.getState(); 
  
  if (alreadyExist) {
    console.log('[StoriesService] Task already exists in queue for user', newTask.chatId, 'and link', newTask.link);
    return tasks;
  }

  if ((isAdmin || newTask.isPremium)) {
     console.log('[StoriesService] Admin/Premium user, adding to front of queue:', newTask.link);
     return [newTask, ...tasks];
  }
  if (taskStartTime === null) { // Only add if no cooldown is active for non-privileged users
     console.log('[StoriesService] Normal user, no cooldown, adding to end of queue:', newTask.link);
     return [...tasks, newTask];
  }
  console.log('[StoriesService] Normal user, cooldown active or other condition not met, task not added to queue:', newTask.link);
  return tasks; 
});

$isTaskRunning.on(taskStarted, () => true).on(taskDone, () => false);
$tasksQueue.on(taskDone, (tasks) => {
  console.log('[StoriesService] taskDone, removing task from queue. Old length:', tasks.length);
  return tasks.slice(1);
}); 

// Only call saveUserFx if user exists
sample({
  clock: newTaskReceived,
  source: $taskSource, 
  filter: (sourceData, newTask) => {
    const shouldRun = !!sourceData.user;
    // console.log('[StoriesService] saveUserFx sample - clock:', newTask.link, 'source user:', sourceData.user?.id, 'filter result:', shouldRun);
    return shouldRun;
  },
  fn: (sourceData, newTask) => sourceData.user!, 
  target: saveUserFx,
});

// Wait/cooldown logic for normal users
sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: ({ taskStartTime, queue, currentTask }, newTask) => { 
    const isAdmin = newTask.chatId === BOT_ADMIN_ID.toString();
    const isPrivileged = isAdmin || newTask.isPremium;
    const isMultipleRequestFromCurrentUser = currentTask?.chatId === newTask.chatId && $isTaskRunning.getState();
    const isCooldownActive = taskStartTime instanceof Date || $isTaskRunning.getState();
    const shouldSendWait = !isPrivileged && (isCooldownActive || isMultipleRequestFromCurrentUser);
    // console.log('[StoriesService] sendWaitMessageFx sample - clock:', newTask.link, 'isPrivileged:', isPrivileged, 'isMultipleRequest:', isMultipleRequestFromCurrentUser, 'isCooldown:', isCooldownActive, 'filter result:', shouldSendWait);
    return shouldSendWait;
  },
  fn: ({ currentTask, taskStartTime, taskTimeout, queue }, newTask) => ({
    multipleRequests: currentTask?.chatId === newTask.chatId && $isTaskRunning.getState(), 
    taskStartTime,
    taskTimeout,
    queueLength: queue.filter(t => t.chatId !== newTask.chatId).length, 
    newTask,
  }),
  target: sendWaitMessageFx,
});

// Task queue advancement
(sample as any)({
  clock: checkTasks,
  filter: () => {
    const conditions = and(not($isTaskRunning), not($taskStartTime), $tasksQueue.map(q => q.length > 0));
    const result = conditions.getState();
    console.log('[StoriesService] checkTasks sample - $isTaskRunning:', $isTaskRunning.getState(), '$taskStartTime:', $taskStartTime.getState(), '$tasksQueue length:', $tasksQueue.getState().length, 'filter result:', result);
    return result;
  },
  target: taskInitiated,
});
(sample as any)({
  clock: taskInitiated,
  source: $tasksQueue,
  fn: (tasks: UserInfo[]) => {
    console.log('[StoriesService] taskInitiated sample - fn: Taking first task from queue. Queue head:', tasks[0]?.link);
    return tasks[0];
  },
  target: [$currentTask, taskStarted], // taskStarted is fired here
});
(sample as any)({ clock: taskInitiated, fn: () => new Date(), target: $taskStartTime });
(sample as any)({ clock: taskInitiated, source: $taskTimeout, target: clearTimeoutWithDelayFx });

$taskTimeout.on(clearTimeoutEvent, (_, newTimeout) => {
  console.log('[StoriesService] $taskTimeout.on(clearTimeoutEvent) - new timeout value:', newTimeout);
  return newTimeout;
});
(sample as any)({ 
    clock: clearTimeoutEvent, 
    fn: () => {
        console.log('[StoriesService] clearTimeoutEvent sample: Resetting $taskStartTime and calling checkTasks.');
        return null;
    }, 
    target: [$taskStartTime, checkTasks] 
});

// ---- TRIGGER STORY FETCHING BASED ON CURRENT TASK ----
// When a task has started, and it's for a username, call getAllStoriesFx
(sample as any)({
  clock: taskStarted, 
  source: $currentTask, 
  filter: (task: UserInfo | null): task is UserInfo => {
    const result = task !== null && task.linkType === 'username';
    console.log('[StoriesService] getAllStoriesFx trigger - taskStarted, current task linkType:', task?.linkType, 'filter result:', result);
    return result;
  },
  fn: (task: UserInfo) => {
    console.log('[StoriesService] getAllStoriesFx trigger - fn: Preparing to call getAllStoriesFx for task:', JSON.stringify(task));
    return task;
  }, 
  target: getAllStoriesFx,
});

// When a task has started, and it's for a specific link, call getParticularStoryFx
(sample as any)({
  clock: taskStarted, 
  source: $currentTask, 
  filter: (task: UserInfo | null): task is UserInfo => {
    const result = task !== null && task.linkType === 'link';
    console.log('[StoriesService] getParticularStoryFx trigger - taskStarted, current task linkType:', task?.linkType, 'filter result:', result);
    return result;
  },
  fn: (task: UserInfo) => {
    console.log('[StoriesService] getParticularStoryFx trigger - fn: Preparing to call getParticularStoryFx for task:', JSON.stringify(task));
    return task;
  }, 
  target: getParticularStoryFx,
});


// ----- MODERN EFFECTOR V22+: CORRECT EFFECT HANDLING -----
// Handle errors for getAllStoriesFx (return string)
(sample as any)({ 
  clock: getAllStoriesFx.done,
  filter: ({ result }: { result: any }) => {
    const isError = typeof result === 'string';
    // console.log('[StoriesService] getAllStoriesFx.done (error path) - result type:', typeof result, 'isError:', isError);
    return isError;
  },
  fn: ({ params, result }: { params: UserInfo, result: string }) => {
    console.log('[StoriesService] getAllStoriesFx.done (error path) - fn: Error for task', params.link, 'Message:', result);
    return ({ task: params, message: result });
  },
  target: [sendErrorMessageFx, taskDone],
});
getAllStoriesFx.fail.watch(({params, error}) => console.error('[StoriesService] getAllStoriesFx.fail for task:', params.link, 'Error:', error));


// Handle errors for getParticularStoryFx (return string)
(sample as any)({ 
  clock: getParticularStoryFx.done,
  filter: ({ result }: { result: any }) => {
    const isError = typeof result === 'string';
    // console.log('[StoriesService] getParticularStoryFx.done (error path) - result type:', typeof result, 'isError:', isError);
    return isError;
  },
  fn: ({ params, result }: { params: UserInfo, result: string }) => {
    console.log('[StoriesService] getParticularStoryFx.done (error path) - fn: Error for task', params.link, 'Message:', result);
    return ({ task: params, message: result });
  },
  target: [sendErrorMessageFx, taskDone],
});
getParticularStoryFx.fail.watch(({params, error}) => console.error('[StoriesService] getParticularStoryFx.fail for task:', params.link, 'Error:', error));


// Handle successful result for getAllStoriesFx
(sample as any)({ 
  clock: getAllStoriesFx.done,
  filter: ({ result }: { result: any }) => {
    const isSuccess = typeof result === 'object';
    // console.log('[StoriesService] getAllStoriesFx.done (success path) - result type:', typeof result, 'isSuccess:', isSuccess);
    return isSuccess;
  },
  fn: ({ params, result }: { params: UserInfo, result: { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[] } }) => {
    console.log('[StoriesService] getAllStoriesFx.done (success path) - fn: Success for task', params.link);
    return ({
      task: params,
      ...(result as any) 
    });
  },
  target: sendStoriesFx,
});

// Handle successful result for getParticularStoryFx
(sample as any)({ 
  clock: getParticularStoryFx.done,
  filter: ({ result }: { result: any }) => {
    const isSuccess = typeof result === 'object';
    // console.log('[StoriesService] getParticularStoryFx.done (success path) - result type:', typeof result, 'isSuccess:', isSuccess);
    return isSuccess;
  },
  fn: ({ params, result }: { params: UserInfo, result: { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[], particularStory?: Api.TypeStoryItem } }) => {
    console.log('[StoriesService] getParticularStoryFx.done (success path) - fn: Success for task', params.link);
    return ({
      task: params,
      ...(result as any)
    });
  },
  target: sendStoriesFx,
});
sendStoriesFx.done.watch(({params}) => console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link));
sendStoriesFx.fail.watch(({params, error}) => console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error));


// After stories sent, finish task
(sample as any)({ 
    clock: sendStoriesFx.done, 
    fn: () => console.log('[StoriesService] sendStoriesFx.done sample: Triggering taskDone.'),
    target: taskDone 
});

(sample as any)({
  clock: taskDone,
  source: $currentTask,
  filter: (task: UserInfo | null): task is UserInfo => {
    // console.log('[StoriesService] taskDone sample (cleanup) - current task:', task?.link, 'filter result:', task !== null);
    return task !== null;
  }, 
  target: cleanupTempMessagesFx,
});
(sample as any)({
  clock: cleanUpTempMessagesFired,
  source: $currentTask,
  filter: (task: UserInfo | null): task is UserInfo => {
    // console.log('[StoriesService] cleanUpTempMessagesFired sample - current task:', task?.link, 'filter result:', task !== null);
    return task !== null;
  }, 
  target: cleanupTempMessagesFx,
});

// Prevent error if no current task (null)
$currentTask.on(tempMessageSent, (prev, msgId) => {
  if (!prev) return prev;
  return { ...prev, tempMessages: [...(prev.tempMessages ?? []), msgId] };
});
$currentTask.on(cleanupTempMessagesFx.done, (prev) => {
  console.log('[StoriesService] cleanupTempMessagesFx.done, clearing tempMessages for task:', prev?.link);
  if (!prev) return prev;
  return { ...prev, tempMessages: [] }; 
});
$currentTask.on(taskDone, () => {
  console.log('[StoriesService] $currentTask.on(taskDone): Setting $currentTask to null.');
  return null;
}); 

// Periodic watchdog: restart bot if task too slow (7 min+)
const intervalHasPassed = createEvent();
(sample as any)({ clock: intervalHasPassed, source: $currentTask, target: checkTaskForRestart });
setInterval(() => {
    // console.log('[StoriesService] Interval: Firing intervalHasPassed');
    intervalHasPassed();
}, 30_000); 

// ---- EXPORTS ----
export {
  tempMessageSent,
  cleanUpTempMessagesFired,
  newTaskReceived,
  checkTasks, 
};
