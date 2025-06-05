import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories'; // This is the effect in question
import { createEffect, createEvent, createStore, sample, combine } from 'effector';
import { bot } from 'index';
import { getRandomArrayItem } from 'lib';
import { and, not } from 'patronum';
import { saveUser } from 'repositories/user-repository';
import { User } from 'telegraf/typings/core/types/typegram';
import { Api } from 'telegram';

// Log the kind of sendStoriesFx to ensure it's an effect
console.log('[StoriesService] sendStoriesFx.kind:', sendStoriesFx.kind); // Should output 'effect'

// ---- DATA TYPES ----
export interface UserInfo {
  chatId: string;
  link: string;
  linkType: 'username' | 'link';
  nextStoriesIds?: number[];
  locale: string;
  user?: User; // Telegraf User object, contains is_premium
  tempMessages?: number[];
  initTime: number;
  isPremium?: boolean; // This should be reliably set when UserInfo is created
}

// ---- STORES ----
const $currentTask = createStore<UserInfo | null>(null);
const $tasksQueue = createStore<UserInfo[]>([]);
const $isTaskRunning = createStore(false);
const $taskStartTime = createStore<Date | null>(null);
const clearTimeoutEvent = createEvent<number>();
const $taskTimeout = createStore(isDevEnv ? 20000 : 240000); // Cooldown for non-privileged users

// ---- EVENTS ----
const newTaskReceived = createEvent<UserInfo>();
const taskInitiated = createEvent();
const taskStarted = createEvent();
const tempMessageSent = createEvent<number>();
const taskDone = createEvent<void>();
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
const timeoutList = isDevEnv ? [10000, 15000, 20000] : [240000, 300000, 360000]; // Used for $taskTimeout values
const clearTimeoutWithDelayFx = createEffect((currentTimeout: number) => {
  console.log('[StoriesService] clearTimeoutWithDelayFx called with timeout:', currentTimeout);
  const nextTimeout = getRandomArrayItem(timeoutList, currentTimeout);
  setTimeout(() => clearTimeoutEvent(nextTimeout), currentTimeout);
});

const MAX_WAIT_TIME = 7; // Overall task timeout in minutes
const LARGE_ITEM_THRESHOLD = 100; // Threshold for sending "long download" warning

const checkTaskForRestart = createEffect(async (task: UserInfo | null) => {
  if (task) {
    const minsFromStart = Math.floor((Date.now() - task.initTime) / 60000);
    console.log(`[StoriesService] checkTaskForRestart: Task for ${task.link} (User: ${task.chatId}), ${minsFromStart} mins from start.`);

    if (minsFromStart >= MAX_WAIT_TIME) { // Check if max wait time is reached or exceeded
      const isAdmin = task.chatId === BOT_ADMIN_ID.toString();
      const isPremiumUser = task.isPremium === true;

      if (isAdmin || isPremiumUser) {
        console.warn(`[StoriesService] Admin/Premium task for ${task.link} (User: ${task.chatId}) has been running for ${minsFromStart} minutes. Allowing to continue beyond MAX_WAIT_TIME.`);
        try {
          await bot.telegram.sendMessage(task.chatId, `🔔 Your request for "${task.link}" is taking a while (${minsFromStart} mins) but is still processing. Please be patient.`);
        } catch (e) {
          console.error(`[StoriesService] Failed to send long task notification to admin/premium user ${task.chatId}:`, e);
        }
      } else {
        console.error(`[StoriesService] Task for ${task.link} (User: ${task.chatId}) took too long (${minsFromStart} mins), exiting process.`);
        await bot.telegram.sendMessage(
          BOT_ADMIN_ID, 
          `❌ Task for user ${task.chatId} (link: ${task.link}) took too long (${minsFromStart} mins) and the bot process was terminated.\n\nDetails: ${JSON.stringify(task, null, 2)}`
        );
        process.exit(1); 
      }
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
  const isPremiumUser = newTask.isPremium === true;
  const alreadyExist = tasks.some(x => x.chatId === newTask.chatId && x.link === newTask.link); 
  const taskStartTime = $taskStartTime.getState(); 
  
  if (alreadyExist) {
    console.log('[StoriesService] Task already exists in queue for user', newTask.chatId, 'and link', newTask.link);
    return tasks;
  }

  if (isAdmin || isPremiumUser) {
     console.log('[StoriesService] Admin/Premium user, adding to front of queue:', newTask.link);
     return [newTask, ...tasks];
  }
  if (taskStartTime === null) { 
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
  filter: (sourceData, newTask) => !!sourceData.user,
  fn: (sourceData, newTask) => sourceData.user!, 
  target: saveUserFx,
});

// Wait/cooldown logic for normal users
sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: ({ taskStartTime, queue, currentTask }, newTask) => { 
    const isAdmin = newTask.chatId === BOT_ADMIN_ID.toString();
    const isPremiumUser = newTask.isPremium === true;
    const isPrivileged = isAdmin || isPremiumUser;
    const isMultipleRequestFromCurrentUser = currentTask?.chatId === newTask.chatId && $isTaskRunning.getState();
    const isCooldownActive = taskStartTime instanceof Date || $isTaskRunning.getState();
    return !isPrivileged && (isCooldownActive || isMultipleRequestFromCurrentUser);
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

// ---- TASK PROCESSING INITIATION ----
sample({
  clock: $tasksQueue.updates, 
  source: { isRunning: $isTaskRunning, startTime: $taskStartTime, queue: $tasksQueue },
  filter: ({ isRunning, startTime, queue }) => {
    const shouldCheck = !isRunning && startTime === null && queue.length > 0;
    console.log('[StoriesService] $tasksQueue.updates based checkTasks trigger - isRunning:', isRunning, 'startTime:', startTime, 'queue.length:', queue.length, 'filter result:', shouldCheck);
    return shouldCheck;
  },
  target: checkTasks,
});

(sample as any)({
  clock: checkTasks, 
  filter: () => {
    const conditionsMet = !$isTaskRunning.getState() && $taskStartTime.getState() === null && $tasksQueue.getState().length > 0;
    console.log('[StoriesService] checkTasks sample to taskInitiated - $isTaskRunning:', $isTaskRunning.getState(), '$taskStartTime:', $taskStartTime.getState(), '$tasksQueue length:', $tasksQueue.getState().length, 'filter result:', conditionsMet);
    return conditionsMet;
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
  target: [$currentTask, taskStarted], 
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
(sample as any)({ 
  clock: getAllStoriesFx.done,
  filter: ({ result }: { result: any }) => typeof result === 'string',
  fn: ({ params, result }: { params: UserInfo, result: string }) => {
    console.log('[StoriesService] getAllStoriesFx.done (error path) - fn: Error for task', params.link, 'Message:', result);
    return ({ task: params, message: result });
  },
  target: [sendErrorMessageFx, taskDone],
});
getAllStoriesFx.fail.watch(({params, error}) => console.error('[StoriesService] getAllStoriesFx.fail for task:', params.link, 'Error:', error));

(sample as any)({ 
  clock: getParticularStoryFx.done,
  filter: ({ result }: { result: any }) => typeof result === 'string',
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
  filter: ({ result }: { result: any }) => typeof result === 'object',
  fn: ({ params: taskFromGetAll, result: resultFromGetAll }: { params: UserInfo, result: { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[] } }) => {
    console.log('[StoriesService] getAllStoriesFx.done (success path) - fn (SYNC): Processing for task', taskFromGetAll.link);
        
    const paramsForSendStoriesFx = {
      task: taskFromGetAll, 
      activeStories: resultFromGetAll.activeStories || [],
      pinnedStories: resultFromGetAll.pinnedStories || [],
      paginatedStories: resultFromGetAll.paginatedStories, 
      particularStory: undefined 
    };
    console.log('[StoriesService] Params being passed to sendStoriesFx (SYNC):', JSON.stringify(paramsForSendStoriesFx).substring(0, 500) + "..."); 
    return paramsForSendStoriesFx;
  },
  target: sendStoriesFx,
});

(sample as any)({ 
  clock: getParticularStoryFx.done,
  filter: ({ result }: { result: any }) => typeof result === 'object',
  fn: ({ params: taskFromGetParticular, result: resultFromGetParticular }: { params: UserInfo, result: { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[], particularStory?: Api.TypeStoryItem } }) => {
    console.log('[StoriesService] getParticularStoryFx.done (success path) - fn: Success for task', taskFromGetParticular.link);
    const paramsForSendStoriesFx = {
        task: taskFromGetParticular,
        activeStories: resultFromGetParticular.activeStories || [],
        pinnedStories: resultFromGetParticular.pinnedStories || [],
        paginatedStories: resultFromGetParticular.paginatedStories,
        particularStory: resultFromGetParticular.particularStory
    };
    console.log('[StoriesService] Params being passed to sendStoriesFx (particular story):', JSON.stringify(paramsForSendStoriesFx).substring(0,500) + "..."); 
    return paramsForSendStoriesFx;
  },
  target: sendStoriesFx,
});

// MODIFIED .watch calls to be more robust to potential void payload (typescript workaround)
sendStoriesFx.done.watch((payload: unknown) => { // Changed type to unknown for initial check
  console.log('[StoriesService] sendStoriesFx.done raw payload:', payload); 
  // Type guard to check if payload is an object with the expected structure
  if (payload && typeof payload === 'object' && 
      'params' in payload && (payload as any).params && 
      typeof (payload as any).params === 'object' && (payload as any).params.task && 
      typeof (payload as any).params.task.link === 'string') {
    const typedPayload = payload as { params: { task: UserInfo }, result: any };
    console.log('[StoriesService] sendStoriesFx.done for task:', typedPayload.params.task.link, "Result:", JSON.stringify(typedPayload.result));
  } else {
    const paramsString = (payload && typeof payload === 'object' && 'params' in payload) ? JSON.stringify((payload as any).params) : 'N/A or payload not an object';
    const resultString = (payload && typeof payload === 'object' && 'result' in payload) ? JSON.stringify((payload as any).result) : 'N/A or payload not an object';
    console.error('[StoriesService] sendStoriesFx.done: params.task.link is not accessible or payload is void/unexpected. Full payload.params:', paramsString, "Result:", resultString);
    
    if (payload && typeof payload === 'object' && 'result' in payload && (payload as any).result && 
        typeof (payload as any).result === 'object' && (payload as any).result.task && 
        typeof (payload as any).result.task.link === 'string') {
        console.warn('[StoriesService] sendStoriesFx.done: Task info found in payload.result.task.link:', (payload as any).result.task.link);
    }
  }
});

sendStoriesFx.fail.watch((payload: unknown) => { // Changed type to unknown for initial check
  console.log('[StoriesService] sendStoriesFx.fail raw payload:', payload); 
  // Type guard
  if (payload && typeof payload === 'object' && 
      'params' in payload && (payload as any).params && 
      typeof (payload as any).params === 'object' && (payload as any).params.task && 
      typeof (payload as any).params.task.link === 'string' && 'error' in payload) {
    const typedPayload = payload as { params: { task: UserInfo }, error: any };
    console.error('[StoriesService] sendStoriesFx.fail for task:', typedPayload.params.task.link, 'Error:', typedPayload.error);
  } else {
    const paramsString = (payload && typeof payload === 'object' && 'params' in payload) ? JSON.stringify((payload as any).params) : 'N/A or payload not an object';
    const errorString = (payload && typeof payload === 'object' && 'error' in payload) ? (payload as any).error : 'N/A or payload not an object';
    console.error('[StoriesService] sendStoriesFx.fail: params.task.link is not accessible or payload is void/unexpected. Error:', errorString, 'Full payload.params:', paramsString);

     if (payload && typeof payload === 'object' && 'error' in payload && (payload as any).error && 
         typeof (payload as any).error === 'object' && (payload as any).error.params && 
         typeof (payload as any).error.params === 'object' && (payload as any).error.params.task && 
         typeof (payload as any).error.params.task.link === 'string') {
        console.warn('[StoriesService] sendStoriesFx.fail: Task info might be in error.params.task.link:', (payload as any).error.params.task.link);
    }
  }
});


(sample as any)({ 
    clock: sendStoriesFx.done, 
    fn: () => console.log('[StoriesService] sendStoriesFx.done sample: Triggering taskDone.'),
    target: taskDone 
});

(sample as any)({
  clock: taskDone,
  source: $currentTask,
  filter: (task: UserInfo | null): task is UserInfo => task !== null, 
  target: cleanupTempMessagesFx,
});
(sample as any)({
  clock: cleanUpTempMessagesFired,
  source: $currentTask,
  filter: (task: UserInfo | null): task is UserInfo => task !== null, 
  target: cleanupTempMessagesFx,
});

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

const intervalHasPassed = createEvent();
(sample as any)({ clock: intervalHasPassed, source: $currentTask, target: checkTaskForRestart });
setInterval(() => {
    intervalHasPassed();
}, 30_000); 

// ---- EXPORTS ----
export {
  tempMessageSent,
  cleanUpTempMessagesFired,
  newTaskReceived,
  checkTasks, 
};

// Initial check for tasks when the service starts
setTimeout(() => {
    console.log('[StoriesService] Initial checkTasks() call on startup.');
    checkTasks();
}, 100);
