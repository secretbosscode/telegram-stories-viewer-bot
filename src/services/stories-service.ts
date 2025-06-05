import { BOT_ADMIN_ID, isDevEnv } from 'config/env-config';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendErrorMessageFx } from 'controllers/send-message';
import { sendStoriesFx } from 'controllers/send-stories';
import { createEffect, createEvent, createStore, sample, combine, Event, StoreValue } from 'effector'; // Added StoreValue
import { bot } from 'index';
import { getRandomArrayItem } from 'lib';
import { and, not } from 'patronum';
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
const taskInitiated = createEvent<void>(); // Target for this event should expect void or handle its absence
const taskStarted = createEvent<UserInfo>();
const tempMessageSent = createEvent<number>();
const taskDone = createEvent<void>();
const checkTasks = createEvent<void>(); // Typically a trigger event, payload often void
const cleanUpTempMessagesFired = createEvent();

newTaskReceived.watch(task => console.log('[StoriesService] newTaskReceived:', JSON.stringify(task)));
taskInitiated.watch(() => console.log('[StoriesService] taskInitiated called.'));
taskStarted.watch((task) => console.log('[StoriesService] taskStarted called for task:', task?.link));
$currentTask.updates.watch(task => console.log('[StoriesService] $currentTask updated:', JSON.stringify(task)));
checkTasks.watch(() => console.log('[StoriesService] checkTasks event called.'));
$tasksQueue.updates.watch(queue => console.log('[StoriesService] $tasksQueue updated. Length:', queue.length, 'Links:', queue.map(t => t.link)));

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

// Define a type for the snapshot of $taskSource
type TaskSourceSnapshot = StoreValue<typeof $taskSource>;

const $taskSource = combine({
  currentTask: $currentTask,
  taskStartTime: $taskStartTime,
  taskTimeout: $taskTimeout,
  queue: $tasksQueue,
  user: $currentTask.map(task => task?.user ?? null),
});

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
    if (remainingMs > 0) {
      const minutes = Math.floor(remainingMs / 60000);
      const seconds = Math.floor((remainingMs % 60000) / 1000);
      const timeToWait = minutes > 0 ? `${minutes} minute(s) and ${seconds} seconds` : `${seconds} seconds`;
      // Re-verified syntax for this call (around original error line 172)
      await bot.telegram.sendMessage(
        newTask.chatId,
        `⏳ Please wait ***${timeToWait}*** before sending another link.\n\nYou can get ***unlimited access*** to our bot without waiting.\nRun the ***/premium*** command to upgrade.`,
        { parse_mode: 'Markdown' }
      );
    }
  }
});

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

$tasksQueue.on(newTaskReceived, (tasks, newTask) => {
  console.log('[StoriesService] $tasksQueue.on(newTaskReceived) - current queue length:', tasks.length, 'new task:', newTask.link);
  const isAdmin = newTask.chatId === BOT_ADMIN_ID.toString();
  const isPremiumUser = newTask.isPremium === true;
  const alreadyExist = tasks.some(x => x.chatId === newTask.chatId && x.link === newTask.link);
  if (alreadyExist) {
    console.log('[StoriesService] Task already exists in queue for user', newTask.chatId, 'and link', newTask.link);
    return tasks;
  }
  if (isAdmin || isPremiumUser) {
    console.log('[StoriesService] Admin/Premium user, adding to front of queue:', newTask.link);
    return [newTask, ...tasks];
  }
  console.log('[StoriesService] Normal user, adding to end of queue:', newTask.link);
  return [...tasks, newTask];
});

$isTaskRunning.on(taskStarted, () => true).on(taskDone, () => false);
$tasksQueue.on(taskDone, (tasks) => {
  console.log('[StoriesService] taskDone, removing task from queue. Old length:', tasks.length);
  if (tasks.length > 0) return tasks.slice(1);
  return [];
});

sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: (source: TaskSourceSnapshot, newTask: UserInfo): source is TaskSourceSnapshot & { user: User } => !!source.user,
  fn: (source: TaskSourceSnapshot & { user: User }, newTask: UserInfo): User => source.user,
  target: saveUserFx,
});

// This is the sample with original error line 179
sample({
  clock: newTaskReceived,
  source: $taskSource,
  filter: (source: TaskSourceSnapshot, newTask: UserInfo): boolean => {
    const { taskStartTime, currentTask } = source; // Destructure after typing
    const isAdmin = newTask.chatId === BOT_ADMIN_ID.toString();
    const isPremiumUser = newTask.isPremium === true;
    const isPrivileged = isAdmin || isPremiumUser;
    if (!isPrivileged) {
      const isAnotherTaskRunning = $isTaskRunning.getState() && currentTask?.chatId !== newTask.chatId;
      const isSystemCooldownActive = taskStartTime instanceof Date;
      if (isAnotherTaskRunning || isSystemCooldownActive) {
        return true;
      }
    }
    return false;
  },
  fn: (source: TaskSourceSnapshot, newTask: UserInfo) => {
    const { taskStartTime, taskTimeout, queue } = source; // Destructure after typing
    const otherUsersInQueue = queue.filter(t => t.chatId !== newTask.chatId && t.link !== newTask.link).length;
    return {
      multipleRequests: false,
      taskStartTime,
      taskTimeout,
      queueLength: otherUsersInQueue,
      newTask,
    };
  },
  target: sendWaitMessageFx,
});

// ---- TASK PROCESSING INITIATION ----
// This is the sample with original error line 192
type TaskInitiationSource = {
  isRunning: boolean;
  currentSystemCooldownStartTime: Date | null;
  queue: UserInfo[];
};

sample({
  clock: [checkTasks, $tasksQueue.updates.map((_: UserInfo[]) => undefined as void)], // Map to Event<void>
  source: {
    isRunning: $isTaskRunning,
    currentSystemCooldownStartTime: $taskStartTime,
    queue: $tasksQueue
  } as StoreValue<TaskInitiationSource>, // Explicitly type source if combine isn't used
  filter: (sourceValues: TaskInitiationSource, _clockPayload: void): boolean => {
    const { isRunning, currentSystemCooldownStartTime, queue } = sourceValues;
    if (isRunning || queue.length === 0) {
      console.log('[StoriesService] Task Initiation Filter: Bot is running or queue is empty. Skip check.');
      return false;
    }
    const nextTaskInQueue = queue[0];
    if (!nextTaskInQueue) {
      console.log('[StoriesService] Task Initiation Filter: Queue not empty, but no task at queue[0]. Skipping.');
      return false;
    }
    const isAdmin = nextTaskInQueue.chatId === BOT_ADMIN_ID.toString();
    const isPremiumUser = nextTaskInQueue.isPremium === true;
    if (isAdmin || isPremiumUser) {
      console.log(`[StoriesService] Task Initiation Filter: Next task for Admin/Premium user (${nextTaskInQueue.link}). Bypassing system cooldown. Attempting to start.`);
      return true;
    }
    const canNormalUserStart = currentSystemCooldownStartTime === null;
    console.log(`[StoriesService] Task Initiation Filter: Next task for Normal user (${nextTaskInQueue.link}). System cooldown active? ${!canNormalUserStart}. Can start? ${canNormalUserStart}`);
    return canNormalUserStart;
  },
  target: taskInitiated, // taskInitiated is Event<void>, filter result (boolean) controls if it fires
});


sample({
  clock: taskInitiated, // Clock payload is void
  source: $tasksQueue,
  filter: (queue: UserInfo[], _clockPayload: void): boolean => queue.length > 0 && !$isTaskRunning.getState(),
  fn: (tasks: UserInfo[], _clockPayload: void): UserInfo => {
    console.log('[StoriesService] taskInitiated effect: Taking first task from queue. Queue head:', tasks[0]?.link);
    return tasks[0];
  },
  target: [$currentTask, taskStarted],
});

sample({
  clock: taskInitiated,
  source: $taskTimeout,
  filter: (timeoutDuration: number, _clock: void): boolean => timeoutDuration > 0,
  fn: (timeoutDuration: number, _clock: void): Date => new Date(),
  target: $taskStartTime
});
sample({
  clock: taskInitiated,
  source: $taskTimeout,
  filter: (timeoutDuration: number, _clock: void): boolean => timeoutDuration > 0,
  fn: (timeoutDuration: number, _clock: void): number => timeoutDuration, // Pass timeoutDuration to effect
  target: clearTimeoutWithDelayFx
});

$taskTimeout.on(clearTimeoutEvent, (_, newTimeout: number) => {
  console.log('[StoriesService] $taskTimeout.on(clearTimeoutEvent) - new timeout value:', newTimeout);
  return newTimeout;
});

sample({
  clock: clearTimeoutEvent,
  fn: (): null => {
    console.log('[StoriesService] System Cooldown Timer (clearTimeoutEvent) finished. Resetting $taskStartTime and calling checkTasks.');
    return null;
  },
  target: [$taskStartTime, checkTasks as Event<null>] // checkTasks is Event<void>, null is assignable to void
});

// ---- TRIGGER STORY FETCHING BASED ON CURRENT TASK ----
sample({
  clock: taskStarted, // Event<UserInfo>
  // source: $currentTask, // Not strictly needed if taskStarted payload is used
  filter: (startedTask: UserInfo): startedTask is UserInfo => // Use startedTask directly
    startedTask.linkType === 'username',
  fn: (startedTask: UserInfo): UserInfo => {
    console.log('[StoriesService] getAllStoriesFx trigger - fn: Preparing to call getAllStoriesFx for task:', JSON.stringify(startedTask));
    return startedTask;
  },
  target: getAllStoriesFx,
});

sample({
  clock: taskStarted, // Event<UserInfo>
  filter: (startedTask: UserInfo): startedTask is UserInfo =>
    startedTask.linkType === 'link',
  fn: (startedTask: UserInfo): UserInfo => {
    console.log('[StoriesService] getParticularStoryFx trigger - fn: Preparing to call getParticularStoryFx for task:', JSON.stringify(startedTask));
    return startedTask;
  },
  target: getParticularStoryFx,
});

// ----- MODERN EFFECTOR V22+: CORRECT EFFECT HANDLING -----
type GetAllStoriesDonePayload = { params: UserInfo, result: { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[] } | string };
type GetParticularStoryDonePayload = { params: UserInfo, result: { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[], particularStory?: Api.TypeStoryItem } | string };

sample({
  clock: getAllStoriesFx.done,
  filter: (payload: GetAllStoriesDonePayload): payload is { params: UserInfo, result: string } => typeof payload.result === 'string',
  fn: ({ params, result }: { params: UserInfo, result: string }) => {
    console.log('[StoriesService] getAllStoriesFx.done (error path) - fn: Error for task', params.link, 'Message:', result);
    return ({ task: params, message: result });
  },
  target: [sendErrorMessageFx, taskDone],
});
getAllStoriesFx.fail.watch(({params, error}: {params: UserInfo, error: Error}) => console.error('[StoriesService] getAllStoriesFx.fail for task:', params.link, 'Error:', error));

sample({
  clock: getParticularStoryFx.done,
  filter: (payload: GetParticularStoryDonePayload): payload is { params: UserInfo, result: string } => typeof payload.result === 'string',
  fn: ({ params, result }: { params: UserInfo, result: string }) => {
    console.log('[StoriesService] getParticularStoryFx.done (error path) - fn: Error for task', params.link, 'Message:', result);
    return ({ task: params, message: result });
  },
  target: [sendErrorMessageFx, taskDone],
});
getParticularStoryFx.fail.watch(({params, error}: {params: UserInfo, error: Error}) => console.error('[StoriesService] getParticularStoryFx.fail for task:', params.link, 'Error:', error));

sample({
  clock: getAllStoriesFx.done,
  filter: (payload: GetAllStoriesDonePayload): payload is { params: UserInfo, result: { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[] } } => typeof payload.result === 'object',
  fn: ({ params: taskFromGetAll, result: resultFromGetAll }: { params: UserInfo, result: { activeStories: Api.TypeStoryItem[], pinnedStories: Api.TypeStoryItem[], paginatedStories?: Api.TypeStoryItem[] } }) => {
    console.log('[StoriesService] getAllStoriesFx.done (success path) - fn (SYNC): Processing for task', taskFromGetAll.link);
    const totalStories = (resultFromGetAll.activeStories?.length || 0) + (resultFromGetAll.pinnedStories?.length || 0) + (resultFromGetAll.paginatedStories?.length || 0);
    const isAdmin = taskFromGetAll.chatId === BOT_ADMIN_ID.toString();
    const isPremiumUser = taskFromGetAll.isPremium === true;
    if (totalStories > LARGE_ITEM_THRESHOLD && (isAdmin || isPremiumUser)) {
      console.log(`[StoriesService] Task for ${taskFromGetAll.link} has ${totalStories} items. (Note: Long download warning message sending is fire-and-forget).`);
      bot.telegram.sendMessage(
          taskFromGetAll.chatId,
          `⏳ You're about to process ~${totalStories} story items for "${taskFromGetAll.link}". This might take a while, please be patient! Your request will continue in the background.`
        ).then(msg => tempMessageSent(msg.message_id))
         .catch(e => console.error(`[StoriesService] Failed to send long download warning (SYNC fn) to ${taskFromGetAll.chatId}:`, e));
    }
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

sample({
  clock: getParticularStoryFx.done,
  filter: (payload: GetParticularStoryDonePayload): payload is { params: UserInfo, result: { particularStory?: Api.TypeStoryItem } & object } => typeof payload.result === 'object' && 'particularStory' in payload.result,
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

sendStoriesFx.done.watch((payload: unknown) => {
  console.log('[StoriesService] sendStoriesFx.done raw payload:', payload);
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

sendStoriesFx.fail.watch((payload: unknown) => {
  console.log('[StoriesService] sendStoriesFx.fail raw payload:', payload);
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


sample({
    clock: sendStoriesFx.done,
    fn: (_: any): void => console.log('[StoriesService] sendStoriesFx.done sample: Triggering taskDone.'),
    target: taskDone
});

sample({
  clock: taskDone,
  source: $currentTask,
  filter: (task: UserInfo | null): task is UserInfo => task !== null,
  fn: (task: UserInfo): UserInfo => task, // Pass the task to the target
  target: cleanupTempMessagesFx,
});
sample({
  clock: cleanUpTempMessagesFired,
  source: $currentTask,
  filter: (task: UserInfo | null): task is UserInfo => task !== null,
  fn: (task: UserInfo): UserInfo => task, // Pass the task to the target
  target: cleanupTempMessagesFx,
});

$currentTask.on(tempMessageSent, (prev, msgId) => {
  if (!prev) { // If currentTask is null, create a new minimal UserInfo object
    console.warn("[StoriesService] $currentTask was null when tempMessageSent was called. This is unexpected if a task is active.");
    // This case should ideally not happen if tempMessageSent is only called during an active task.
    // For robustness, create a shell UserInfo, but this indicates a potential logic flaw elsewhere.
    return { chatId: '', link: '', linkType: 'username', initTime: Date.now(), tempMessages: [msgId] } as UserInfo;
  }
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

const intervalHasPassed = createEvent<void>(); // Typically event payloads are defined or void
sample({ clock: intervalHasPassed, source: $currentTask, filter: (task): task is UserInfo => task !== null, target: checkTaskForRestart });
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
