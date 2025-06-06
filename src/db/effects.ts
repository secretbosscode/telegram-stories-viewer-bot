// src/db/effects.ts

import { createEffect } from 'effector';
import * as db from './index'; // Your DB raw functions
import { DownloadQueueItem, UserInfo } from 'types'; // Ensure types are imported correctly

export const enqueueDownloadFx = createEffect(
  async (params: { telegram_id: string; target_username: string }): Promise<boolean> => { // Explicitly type handler return
    return db.enqueueDownload(params.telegram_id, params.target_username);
  }
);

export const getNextQueueItemFx = createEffect<void, DownloadQueueItem | null>(
  // Explicitly type the async handler's return value
  async (): Promise<DownloadQueueItem | null> => {
    return db.getNextQueueItem();
  }
);

export const markProcessingFx = createEffect(
  async (jobId: string): Promise<void> => { // Explicitly type handler return
    return db.markProcessing(jobId);
  }
);

// Add explicit typing for other effects as well:
export const markDoneFx = createEffect(
  async (jobId: string): Promise<void> => {
    return db.markDone(jobId);
  }
);

export const markErrorFx = createEffect(
  async (jobId: string, error: string): Promise<void> => {
    return db.markError(jobId, error);
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
