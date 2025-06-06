// src/db/effects.ts (new file, or integrate into your db/index.ts)
import { createEffect } from 'effector';
import * as db from './index'; // Your DB raw functions
import { DownloadQueueItem, UserInfo } from 'types';

export const enqueueDownloadFx = createEffect(
  async (params: { telegram_id: string; target_username: string }) => {
    return db.enqueueDownload(params.telegram_id, params.target_username);
  }
);

export const getNextQueueItemFx = createEffect<void, DownloadQueueItem | null>(
  async () => {
    return db.getNextQueueItem();
  }
);

export const markProcessingFx = createEffect(async (jobId: string) => {
  return db.markProcessing(jobId);
});

// ... and so on for markDoneFx, markErrorFx, wasRecentlyDownloadedFx, isDuplicatePendingFx, cleanupQueueFx
