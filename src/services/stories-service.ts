// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendStoriesFx } from 'controllers/send-stories';
// --- IMPORTANT: Decide where these core events are defined ---
// If newTaskReceived, tempMessageSent, cleanUpTempMessagesFired, checkTasks are defined
// in your main bot orchestration file (e.g., the large Effector file that was
// previously named webhook.ts in your logs), then IMPORT them from there:
import { newTaskReceived, tempMessageSent, cleanUpTempMessagesFired } from 'services/bot-orchestrator-file'; // <--- YOU MUST REPLACE 'services/bot-orchestrator-file' with the correct path to that file!

// If, however, stories-service.ts is the *only* place these are defined, then keep their 'export const' and remove the bottom 'export {}' block.
// For now, I'm assuming they are defined elsewhere (e.g., your main queue orchestration) and imported here.

import { UserInfo } from 'types'; // Corrected import path for UserInfo (as per your tsconfig.json and src/types.ts)

// Keep a store of "temporary" message IDs, so you can delete or clean them up later
export const $tempMessages = createStore<number[]>([]);

// Add message ID to temp messages (exported so others can call it)
// REMOVED: export const tempMessageSent = createEvent<number>(); // THIS IS NOW IMPORTED
$tempMessages.on(tempMessageSent, (list, id) => [...list, id]);

// Clear temp messages (used after sending a batch)
// REMOVED: export const cleanUpTempMessagesFired = createEvent(); // THIS IS NOW IMPORTED
$tempMessages.on(cleanUpTempMessagesFired, () => []);

// The queue manager triggers this event when a new story task is received
// REMOVED: export const newTaskReceived = createEvent<UserInfo>(); // THIS IS NOW IMPORTED

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
  clock: handleStoryRequest.doneData,
  source: newTaskReceived, // This 'source' will be 'task' here
  // Fixed Spread types error: Added a type predicate to narrow 'result' if it's an object.
  // This assumes getParticularStoryFx/getAllStoriesFx can return either a string (for error) or an object (for success).
  // Ideally, effects should only return success data via doneData and errors via .fail.
  filter: (task, result): result is object => typeof result === 'object' && result !== null,
  fn: (task, result) => ({ ...result, task }), // 'task' is the original 'newTaskReceived' data
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

// REMOVED THIS BLOCK entirely:
// export {
//   newTaskReceived,
//   handleStoryRequest,
//   cleanUpTempMessagesFired,
//   tempMessageSent
// };
