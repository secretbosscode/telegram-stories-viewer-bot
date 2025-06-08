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
  async (params: { telegram_id: string; target_username: string; task_details: UserInfo }): Promise<void> => {
    await db.enqueueDownload(params.telegram_id, params.target_username, params.task_details);
  }
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
  async (params: { telegram_id: string; target_username: string }): Promise<boolean> => {
    return db.isDuplicatePending(params.telegram_id, params.target_username);
  }
);

// Fetch recent history of downloads for admin reporting
export const getRecentHistoryFx = createEffect((limit: number) => db.getRecentHistory(limit));

// Payment check effects
export const addPaymentCheckFx = createEffect(
  async (params: {
    user_id: string;
    invoice_id: number;
    from_address: string;
    next_check: number;
    check_start: number;
  }) => db.addPaymentCheck(params.user_id, params.invoice_id, params.from_address, params.next_check, params.check_start),
);

export const updatePaymentCheckNextFx = createEffect((params: { id: number; next_check: number }) =>
  db.updatePaymentCheckNext(params.id, params.next_check),
);

export const updatePaymentCheckInvoiceFx = createEffect((params: { id: number; invoice_id: number }) =>
  db.updatePaymentCheckInvoice(params.id, params.invoice_id),
);

export const removePaymentCheckFx = createEffect((id: number) => db.removePaymentCheck(id));

export const listPaymentChecksFx = createEffect(() => db.listPaymentChecks());
