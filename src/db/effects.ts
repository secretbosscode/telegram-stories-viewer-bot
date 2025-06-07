// src/db/effects.ts

import { createEffect } from 'effector';
import * as db from './index'; // Your DB raw functions
import { DownloadQueueItem } from 'types';

export const enqueueDownloadFx = createEffect(
  async (params: { telegram_id: string; target_username: string }): Promise<void> => {
    // FIX: The underlying DB function only expects 2 arguments. The 3rd empty object argument was removed.
    await db.enqueueDownload(params.telegram_id, params.target_username);
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

export const markDoneFx = createEffect(
  async (jobId: string): Promise<void> => {
    return db.markDone(jobId);
  }
);

export const markErrorFx = createEffect(
  async (payload: { jobId: string; message: string }): Promise<void> => {
    return db.markError(payload.jobId, payload.message);
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
