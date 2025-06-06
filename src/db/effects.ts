// src/db/effects.ts

import { createEffect } from 'effector';
import * as db from './index'; // Your DB raw functions
import { DownloadQueueItem, UserInfo } from 'types'; // Ensure types are imported correctly

export const enqueueDownloadFx = createEffect(
  async (params: { telegram_id: string; target_username: string }): Promise<boolean> => {
    return db.enqueueDownload(params.telegram_id, params.target_username);
  }
);

export const getNextQueueItemFx = createEffect<void, DownloadQueueItem | null>(
  async (): Promise<DownloadQueueItem | null> => {
    return db.getNextQueueItem();
  }
);

export const markProcessingFx = createEffect(
  async (jobId: string): Promise<void> => {
    return db.markProcessing(jobId);
  }
);

// CORRECTED: markDoneFx expects a single string argument
export const markDoneFx = createEffect(
  async (jobId: string): Promise<void> => { // Parameter is now explicitly `jobId: string`
    return db.markDone(jobId);
  }
);

// CORRECTED: markErrorFx expects two string arguments
export const markErrorFx = createEffect(
  async (jobId: string, message: string): Promise<void> => { // Parameters are now explicitly `jobId: string, message: string`
    return db.markError(jobId, message);
  }
);

export const cleanupQueueFx = createEffect(
  async (): Promise<void> => {
    return db.cleanupQueue();
  }
);

export const wasRecentlyDownloadedFx = createEffect(
  async (params: { telegram_id: string; target_username: string; hours: number }): Promise<boolean> => {
    return db.wasRecentlyDownloaded(params.telegram_id, params.target_username, params.hours);
  }
);

export const isDuplicatePendingFx = createEffect(
  async (params: { telegram_id: string; target_username: string }): Promise<boolean> => {
    return db.isDuplicatePending(params.telegram_id, params.target_username);
  }
);
