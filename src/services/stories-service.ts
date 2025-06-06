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
