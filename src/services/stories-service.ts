// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendStoriesFx } from 'controllers/send-stories';

// --- IMPORTANT: Decide where these core events are defined ---
// As discussed, `newTaskReceived`, `tempMessageSent`, and `cleanUpTempMessagesFired`
// should be defined and exported from your main bot orchestration file (the large
// Effector file that was causing 'createStore' errors in your logs).
// YOU MUST REPLACE 'services/bot-orchestrator-file' with the correct path to that file!
import { newTaskReceived, tempMessageSent, cleanUpTempMessagesFired, checkTasks } from 'services/bot-orchestrator-file'; // <--- ADDED 'checkTasks' here for consistency

// Import necessary types, including SendStoriesFxParams
import { UserInfo, SendStoriesFxParams } from 'types'; // <--- Ensure SendStoriesFxParams is imported!

// Keep a store of "temporary" message IDs, so you can delete or clean them up later
export const $tempMessages = createStore<number[]>([]);

// Add message ID to temp messages (exported so others can call it)
$tempMessages.on(tempMessageSent, (list, id) => [...list, id]);

// Clear temp messages (used after sending a batch)
$tempMessages.on(cleanUpTempMessagesFired, () => []);

// Main handler for processing a story task
export const handleStoryRequest = createEffect(async (task: UserInfo) => {
  // Figure out if this is a particular story or all stories
  if (task.linkType === 'link' && task.link.includes('/s/')) {
    // Single story by link
    return getParticularStoryFx(task);
  }
  // All stories for a user
  return getAllStoriesFx(task);
});

// When a story request succeeds, send the stories
sample({
  clock: handleStoryRequest.doneData, // Output of get*StoriesFx effects
  source: newTaskReceived, // The original UserInfo task that triggered the flow
  // Filter out string errors and nulls, only pass valid story data
  filter: (task, fetchedDataResult): fetchedDataResult is (object | object[]) =>
    typeof fetchedDataResult !== 'string' && fetchedDataResult !== null, // <--- Corrected filter type predicate
  // The 'fn' function transforms the fetched data and task into the exact payload
  // that sendStoriesFx expects (SendStoriesFxParams).
  fn: (task, fetchedDataResult): SendStoriesFxParams => {
    const params: SendStoriesFxParams = { task };

    // Based on the return types of getAllStoriesFx and getParticularStoryFx:
    // getParticularStoryFx returns { activeStories: [], pinnedStories: [], particularStory: storyData.stories[0] }
    // getAllStoriesFx returns { activeStories, pinnedStories } or { activeStories: [], pinnedStories: [], paginatedStories: ... }

    // Check if 'fetchedDataResult' is an object that contains 'particularStory'
    if (typeof fetchedDataResult === 'object' && fetchedDataResult !== null && 'particularStory' in fetchedDataResult && fetchedDataResult.particularStory) {
      params.particularStory = (fetchedDataResult as { particularStory: any }).particularStory;
    }
    // Check if 'fetchedDataResult' is an object that contains 'activeStories' or 'pinnedStories' or 'paginatedStories'
    else if (typeof fetchedDataResult === 'object' && fetchedDataResult !== null && (
      'activeStories' in fetchedDataResult ||
      'pinnedStories' in fetchedDataResult ||
      'paginatedStories' in fetchedDataResult
    )) {
      const data = fetchedDataResult as {
        activeStories?: any[];
        pinnedStories?: any[];
        paginatedStories?: any[];
      };
      if (data.activeStories) params.activeStories = data.activeStories;
      if (data.pinnedStories) params.pinnedStories = data.pinnedStories;
      if (data.paginatedStories) params.paginatedStories = data.paginatedStories;
    }
    // Fallback if unexpected data type - should not happen if effects are well-typed
    else {
      console.error('[stories-service] Unexpected result type from handleStoryRequest.doneData:', fetchedDataResult);
      throw new Error('Unexpected story data type received from fetch effect for sending.');
    }

    return params;
  },
  target: sendStoriesFx,
});

// After any sendStoriesFx call, clean up temp messages
sendStoriesFx.finally.watch(() => {
  cleanUpTempMessagesFired();
});

// After any sendStoriesFx fails, clean up temp messages (to unstick queue)
sendStoriesFx.fail.watch(() => {
  cleanUpTempMessagesFired();
});

// --- Finalization Logic ---
// Note: The `sendStoriesFx.done` and `sendStoriesFx.fail` watches below
// are duplicated with your main orchestrator file. If this file is strictly
// for *preparing* the stories, these finalization watches might belong in
// the orchestrator instead. However, keeping them here to match your provided code.
sendStoriesFx.done.watch(({ params }) => console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link));
sendStoriesFx.fail.watch(({ params, error }) => console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error));
sample({ clock: sendStoriesFx.done, target: [taskDone, checkTasks] }); // <--- Ensure taskDone is imported or defined if needed here
sample({ clock: sendStoriesFx.fail, target: [taskDone, checkTasks] }); // <--- Ensure taskDone is imported or defined if needed here

sample({ clock: taskDone, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: cleanupTempMessagesFx });
$currentTask.on(taskDone, () => null);
$isTaskRunning.on(taskDone, () => false); // <--- $isTaskRunning is not defined in this file! It must be imported!
$tasksQueue.on(taskDone, (tasks) => tasks.length > 0 ? tasks.slice(1) : []); // <--- $tasksQueue is not defined in this file! It must be imported!

$currentTask.on(tempMessageSent, (prev, msgId) => {
  if (!prev) {
    console.warn("[StoriesService] $currentTask was null when tempMessageSent called.");
    // This return value for prev=null needs to create a valid UserInfo object.
    // It's safer to ensure $currentTask is never null if tempMessageSent is called.
    return { chatId: '', link: '', linkType: 'username', locale: 'en', initTime: Date.now(), tempMessages: [msgId], isPremium: false } as UserInfo; // Added missing isPremium
  }
  return { ...prev, tempMessages: [...(prev.tempMessages ?? []), msgId] };
});
$currentTask.on(cleanupTempMessagesFx.done, (prev) => prev ? { ...prev, tempMessages: [] } : null);

// --- Interval Timers ---
const intervalHasPassed = createEvent<void>();
sample({ clock: intervalHasPassed, source: $currentTask, filter: (t): t is UserInfo => t !== null, target: checkTaskForRestart }); // <--- checkTaskForRestart is not defined in this file! It must be imported!
setInterval(() => intervalHasPassed(), 30_000);

// --- Removed redundant exports ---
// This file is now a CONSUMER of newTaskReceived, tempMessageSent, cleanUpTempMessagesFired, checkTasks
// so it should not export them again.
// The handleStoryRequest effect is exported by its declaration.
// export { tempMessageSent, cleanUpTempMessagesFired, newTaskReceived, checkTasks };
