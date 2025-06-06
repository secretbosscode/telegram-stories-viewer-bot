// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendStoriesFx } from 'controllers/send-stories';

// IMPORTANT: Assume these core events/stores/effects are defined and exported from your main orchestrator file.
// YOU MUST REPLACE 'services/bot-orchestrator-file' with the correct path to that file!
// This file is the one that was previously showing 'createStore' errors in your build logs (e.g., src/services/webhook.ts)
import {
  newTaskReceived,
  tempMessageSent,
  cleanUpTempMessagesFired,
  checkTasks,
  taskDone,
  $currentTask,
  $isTaskRunning,
  $tasksQueue,
  checkTaskForRestart,
  cleanupTempMessagesFx // This is the Effect that cleans up messages
} from 'services/bot-orchestrator-file'; // <--- Make sure this path is EXACTLY correct!

// Import necessary types, including SendStoriesFxParams
import { UserInfo, SendStoriesFxParams } from 'types';

// Keep a store of "temporary" message IDs, so you can delete or clean them up later
export const $tempMessages = createStore<number[]>([]);

// Add message ID to temp messages (exported so others can call it)
// (This event is now imported from your orchestrator file)
$tempMessages.on(tempMessageSent, (list, id) => [...list, id]);

// Clear temp messages (used after sending a batch)
// (This event is now imported from your orchestrator file)
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
    typeof fetchedDataResult !== 'string' && fetchedDataResult !== null,
  // The 'fn' function transforms the fetched data and task into the exact payload
  // that sendStoriesFx expects (SendStoriesFxParams).
  fn: (task: UserInfo, fetchedDataResult: object | object[]): SendStoriesFxParams => {
    const params: SendStoriesFxParams = { task };

    // Logic to populate SendStoriesFxParams based on the return type of get*StoriesFx
    if (typeof fetchedDataResult === 'object' && fetchedDataResult !== null) {
      if ('particularStory' in fetchedDataResult && fetchedDataResult.particularStory) {
        params.particularStory = (fetchedDataResult as { particularStory: any }).particularStory;
      }
      else if ('activeStories' in fetchedDataResult || 'pinnedStories' in fetchedDataResult || 'paginatedStories' in fetchedDataResult) {
        const data = fetchedDataResult as {
          activeStories?: any[];
          pinnedStories?: any[];
          paginatedStories?: any[];
        };
        if (data.activeStories) params.activeStories = data.activeStories;
        if (data.pinnedStories) params.pinnedStories = data.pinnedStories;
        if (data.paginatedStories) params.paginatedStories = data.paginatedStories;
      }
      else {
        console.error('[stories-service] Unexpected result type from handleStoryRequest.doneData:', fetchedDataResult);
        throw new Error('Unexpected story data type received from fetch effect for sending.');
      }
    } else {
      console.error('[stories-service] handleStoryRequest.doneData produced non-object/non-array:', fetchedDataResult);
      throw new Error('Invalid data type received from fetch effect.');
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

// --- Finalization Logic (Task state progression) ---
sendStoriesFx.done.watch(({ params }) => console.log('[StoriesService] sendStoriesFx.done for task:', params.task.link));
sendStoriesFx.fail.watch(({ params, error }) => console.error('[StoriesService] sendStoriesFx.fail for task:', params.task.link, 'Error:', error));
sample({ clock: sendStoriesFx.done, target: [taskDone, checkTasks] });
sample({ clock: sendStoriesFx.fail, target: [taskDone, checkTasks] });

// When a task is marked done, trigger cleanupTempMessagesFx
sample({
  clock: taskDone,
  source: $currentTask, // Source the current task state
  filter: (t: UserInfo | null): t is UserInfo => t !== null, // Ensure task is not null
  target: cleanupTempMessagesFx.prepend(task => task) // Prepend the task to the cleanup effect
});

// Update the current task store when a task is done
$currentTask.on(taskDone, () => null);

// Update task running status when a task is done
$isTaskRunning.on(taskDone, () => false);

// Remove the completed task from the queue when done
$tasksQueue.on(taskDone, (tasks: UserInfo[]) => tasks.length > 0 ? tasks.slice(1) : []);

// Handle temporary message IDs sent during processing
$currentTask.on(tempMessageSent, (prev: UserInfo | null, msgId: number) => {
  if (!prev) {
    console.warn("[StoriesService] $currentTask was null when tempMessageSent called.");
    // CORRECTED LINE: Completed the object literal and added closing parentheses
    return { chatId: '', link: '', linkType: 'username', locale: 'en', initTime: Date.now(), tempMessages: [msgId], isPremium: false } as UserInfo;
  }
  return { ...prev, tempMessages: [...(prev.tempMessages ?? []), msgId] };
});

// Clear tempMessages array in the current task state after cleanup effect is done
$currentTask.on(cleanupTempMessagesFx.done, (currentTaskState: UserInfo | null, { params: finishedTaskParams }): UserInfo | null => {
    // Only update if the finished task is the one currently being tracked by $currentTask
    if (currentTaskState && currentTaskState.instanceId === finishedTaskParams.instanceId) {
        return { ...currentTaskState, tempMessages: [] };
    }
    return currentTaskState; // Otherwise, don't modify the state
});

// --- Interval Timers ---
const intervalHasPassed = createEvent<void>();
sample({
  clock: intervalHasPassed,
  source: $currentTask,
  filter: (t: UserInfo | null): t is UserInfo => t !== null,
  target: checkTaskForRestart // This effect should be imported from the orchestrator
});
setInterval(() => intervalHasPassed(), 30_000); // <--- This line is the last one in the file.
