// src/db/effects.ts

import { createEffect } from 'effector';
import * as db from './index';
import { DownloadQueueItem, UserInfo } from 'types';

// =========================================================================
// FINAL FIX: This effect MUST accept the full task details to save them.
// =========================================================================
export const enqueueDownloadFx = createEffect(
  async (params: { telegram_id: string; target_username: string, task_details: UserInfo }): Promise<void> => {
    // IMPORTANT: Your raw `db.enqueueDownload` function must also be updated
    // to accept and store this third 'task_details' argument, likely as a JSON string.
    await db.enqueueDownload(params.telegram_id, params.target_username, params.task_details);
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
