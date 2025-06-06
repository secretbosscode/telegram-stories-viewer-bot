// src/services/webhook.ts

// ... (existing imports)
import {
  newTaskReceived,
  tempMessageSent,
  cleanUpTempMessagesFired // Import these from stories-service.ts
} from 'services/stories-service'; // Assumes 'services/stories-service.ts' is correctly mapped by tsconfig

// =============================================================================
// STORES & EVENTS
// =============================================================================

const $currentTask = createStore<UserInfo | null>(null);
const $tasksQueue = createStore<UserInfo[]>([]);
const $isTaskRunning = createStore(false);
const $taskStartTime = createStore<Date | null>(null);
const clearTimeoutEvent = createEvent<number>();
const $taskTimeout = createStore(isDevEnv ? 20000 : 240000);

// REMOVE THESE LINES, as they're imported from stories-service.ts (if defined there)
// const newTaskReceived = createEvent<UserInfo>();
// const taskReadyToBeQueued = createEvent<UserInfo>(); // Keep this one, seems specific to webhook
// const taskInitiated = createEvent<void>(); // Keep this one, seems specific to webhook
// const taskStarted = createEvent<UserInfo>(); // Keep this one, seems specific to webhook
// const tempMessageSent = createEvent<number>(); // REMOVE
const taskDone = createEvent<void>(); // Keep this one, seems specific to webhook
const checkTasks = createEvent<void>(); // Keep this one here if webhook is its primary owner
// const cleanUpTempMessagesFired = createEvent(); // REMOVE

// ... (rest of webhook.ts)

// =============================================================================
// EXPORTS
// =============================================================================
// REMOVE THIS BLOCK entirely, as it's causing conflicts or is redundant:
// export { tempMessageSent, cleanUpTempMessagesFired, newTaskReceived, checkTasks };

// If you need to export checkTasks, do it explicitly here, or if it's imported from stories-service, remove it.
// Given its usage here, it's likely intended to be internal to webhook or explicitly exported if needed by `index.ts`
// For now, let's assume it's internal to webhook or handled by the `setTimeout` at the bottom.
