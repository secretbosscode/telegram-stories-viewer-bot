// src/db/effects.ts

import { createEffect } from 'effector';
import * as db from './index'; // Your DB raw functions
import { DownloadQueueItem } from 'types'; // Ensure types are imported correctly

/** Enqueues a new download task into the database. */
export const enqueueDownloadFx = createEffect(
  async (params: { telegram_id: string; target_username: string }): Promise<void> => {
    await db.enqueueDownload(params.telegram_id, params.target_username, {}); // Pass empty details object for now
  }
);

/** Fetches the next available 'pending' item from the queue. */
export const getNextQueueItemFx = createEffect<void, DownloadQueueItem | null>(
  async (): Promise<DownloadQueueItem | null> => {
    return db.getNextQueueItem();
  }
);

/** Marks a job as 'in_progress' in the database. */
export const markProcessingFx = createEffect(
  async (jobId: string): Promise<void> => {
    return db.markProcessing(jobId);
  }
);

/** Marks a job as 'done' in the database. */
export const markDoneFx = createEffect(
  async (jobId: string): Promise<void> => {
    return db.markDone(jobId);
  }
);

/**
 * Marks a job as 'error' in the database.
 * FIX: Effects can only take one argument. This now accepts a single payload object.
 */
export const markErrorFx = createEffect(
  async (payload: { jobId: string; message: string }): Promise<void> => {
    return db.markError(payload.jobId, payload.message);
  }
);

/** Cleans up old, completed tasks from the queue. */
export const cleanupQueueFx = createEffect(
  async (): Promise<void> => {
    return db.cleanupQueue();
  }
);

/** Checks if a user/target combination is on cooldown. */
export const wasRecentlyDownloadedFx = createEffect(
  async (params: { telegram_id: string; target_username: string; hours: number }): Promise<boolean> => {
    return db.wasRecentlyDownloaded(params.telegram_id, params.target_username, params.hours);
  }
);

/** Checks if there's already a pending or in-progress task for this user/target. */
export const isDuplicatePendingFx = createEffect(
  async (params: { telegram_id: string; target_username: string }): Promise<boolean> => {
    return db.isDuplicatePending(params.telegram_id, params.target_username);
  }
);
