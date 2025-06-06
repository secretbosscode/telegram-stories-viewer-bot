// src/services/stories-service.ts

import { createEffect, createEvent, createStore, sample } from 'effector';
import { getAllStoriesFx, getParticularStoryFx } from 'controllers/get-stories';
import { sendStoriesFx } from 'controllers/send-stories';
import { UserInfo } from 'types'; // This path needs to be correct in tsconfig.json

// Keep a store of "temporary" message IDs, so you can delete or clean them up later
export const $tempMessages = createStore<number[]>([]);

// Add message ID to temp messages (exported so others can call it)
export const tempMessageSent = createEvent<number>();
$tempMessages.on(tempMessageSent, (list, id) => [...list, id]);

// Clear temp messages (used after sending a batch)
export const cleanUpTempMessagesFired = createEvent();
$tempMessages.on(cleanUpTempMessagesFired, () => []);

// The queue manager triggers this event when a new story task is received
export const newTaskReceived = createEvent<UserInfo>();

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
  filter: (_, result) => typeof result === 'object' && !!result,
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

// REMOVE THIS BLOCK entirely:
// export {
//   newTaskReceived,
//   handleStoryRequest,
//   cleanUpTempMessagesFired,
//   tempMessageSent
// };
