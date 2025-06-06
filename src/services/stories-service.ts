// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendStoriesFx } from 'controllers/send-stories';

// IMPORTANT: Assuming these core events/stores/effects are defined and exported from your main orchestrator file.
// YOU MUST REPLACE 'services/bot-orchestrator-file' with the correct path to that file!
import {
  newTaskReceived,
  tempMessageSent,
  cleanUpTempMessagesFired,
  checkTasks, // Added checkTasks
  taskDone, // Added taskDone
  $currentTask, // Added $currentTask
  $isTaskRunning, // Added $isTaskRunning
  $tasksQueue, // Added $tasksQueue
  checkTaskForRestart, // Added checkTaskForRestart
  cleanupTempMessagesFx // Added cleanupTempMessagesFx (it's an Effect)
} from 'services/bot-orchestrator-file'; // <--- YOU MUST REPLACE THIS PLACEHOLDER PATH!

// Import necessary types, including SendStoriesFxParams
import { UserInfo, SendStoriesFxParams } from 'types';

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
  filter: (task: UserInfo, fetchedDataResult: object | object[]): fetchedDataResult is (object | object[]) =>
    typeof fetchedDataResult !== 'string' && fetchedDataResult !== null, // <--- Parameter types added here
  // The 'fn' function transforms the fetched data and task into the exact payload
  // that sendStoriesFx expects (SendStoriesFxParams).
  fn: (task: UserInfo, fetchedDataResult: object | object[]): SendStoriesFxParams => { // <--- Parameter types added here
    const params: SendStoriesFxParams = { task };

    // Based on the return types of getAllStoriesFx and getParticularStoryFx:
    // getParticularStoryFx returns { activeStories: [], pinnedStories: [], particularStory: storyData.stories[0] }
    // getAllStoriesFx returns { activeStories, pinnedStories } or { activeStories: [], pinnedStories: [], paginatedStories: ... }

    // Check if 'fetchedDataResult' is an object that contains 'particularStory'
    if (typeof fetchedDataResult === 'object' && 'particularStory' in fetchedDataResult && fetchedDataResult.particularStory) {
      params.particularStory = (fetchedDataResult as { particularStory: any }).particularStory;
    }
    // Check if 'fetchedDataResult' is an object that contains 'activeStories' or 'pinnedStories' or 'paginatedStories'
    else if (typeof fetchedDataResult === 'object' && (
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
      if (data.paginatedStories) params.paginatedStories = data.pagagedStories;
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

// --- Finalization Logic (Keep these here if this file manages the task state progression) ---
sendStoriesFx.done.watch(({ params }) => console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link));
sendStoriesFx.fail.watch(({ params, error }) => console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error));
sample({ clock: sendStoriesFx.done, target: [taskDone, checkTasks] });
sample({ clock: sendStoriesFx.fail, target: [taskDone, checkTasks] });

// Corrected type annotations and cleanupTempMessagesFx target
sample({ clock: taskDone, source: $currentTask, filter: (t: UserInfo | null): t is UserInfo => t !== null, target: cleanupTempMessagesFx.prepend(task => task) }); // <--- Fixed target and type

$currentTask.on(taskDone, () => null); // <--- Correct: no params needed here
$isTaskRunning.on(taskDone, () => false); // <--- Correct: no params needed here
$tasksQueue.on(taskDone, (tasks: UserInfo[]) => tasks.length > 0 ? tasks.slice(1) : []); // <--- Parameter type added here

$currentTask.on(tempMessageSent, (prev: UserInfo | null, msgId: number) => { // <--- Parameter types added here
  if (!prev) {
    console.warn("[StoriesService] $currentTask was null when tempMessageSent called.");
    return { chatId: '', link: '', linkType:
