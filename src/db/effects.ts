// src/db/effects.ts

import { createEffect } from 'effector';
import * as db from './index';
import { DownloadQueueItem, UserInfo } from 'types';

// =========================================================================
// PROCESS COMMENT: This effect is the bridge to your database. It must
// accept the full task_details object to pass it to the database function,
// ensuring no data is lost when a task is queued.
// =========================================================================
export const enqueueDownloadFx = createEffect(
  async (
    params: { telegram_id: string; target_username: string; task_details: UserInfo },
  ): Promise<number> => {
    return db.enqueueDownload(params.telegram_id, params.target_username, params.task_details);
  },
);

export const getNextQueueItemFx = createEffect<void, DownloadQueueItem | null>(() => db.getNextQueueItem());

export const markProcessingFx = createEffect((jobId: string) => db.markProcessing(jobId));

export const markDoneFx = createEffect((jobId: string) => db.markDone(jobId));

export const markErrorFx = createEffect(
  async (payload: { jobId: string; message: string }): Promise<void> => {
    return db.markError(payload.jobId, payload.message);
  }
);

export const cleanupQueueFx = createEffect(() => db.cleanupQueue());

export const wasRecentlyDownloadedFx = createEffect(
  async (params: { telegram_id: string; target_username: string; hours: number }): Promise<boolean> => {
    return db.wasRecentlyDownloaded(params.telegram_id, params.target_username, params.hours);
  }
);

export const isDuplicatePendingFx = createEffect(
  async (
    params: { telegram_id: string; target_username: string; nextStoriesIds?: number[] },
  ): Promise<boolean> => {
    return db.isDuplicatePending(
      params.telegram_id,
      params.target_username,
      params.nextStoriesIds,
    );
  },
);

export const findPendingJobFx = createEffect((telegram_id: string) => db.findPendingJobId(telegram_id));

export const getQueueStatsFx = createEffect((jobId: number) => db.getQueueStats(jobId));

// Fetch recent history of downloads for admin reporting
export const getRecentHistoryFx = createEffect((limit: number) => db.getRecentHistory(limit));
