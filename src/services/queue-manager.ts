// src/services/queue-manager.ts

import {
  enqueueDownloadFx,
  getNextQueueItemFx,
  markProcessingFx,
  markDoneFx,
  markErrorFx,
  cleanupQueueFx,
  runMaintenanceFx,
  wasRecentlyDownloadedFx,
  getDownloadCooldownRemainingFx,
  isDuplicatePendingFx,
  getQueueStatsFx,
  findPendingJobFx,
  recordUserRequestFx,
  countRecentUserRequestsFx,
  countPendingJobsFx,
} from 'db/effects';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { sendTemporaryMessage } from 'lib';
import { UserInfo, DownloadQueueItem, SendStoriesFxParams } from 'types';
import { t } from 'lib/i18n';
import { getAllStoriesFx, getParticularStoryFx, getArchivedStoriesFx } from 'controllers/get-stories';
import { sendStoriesFx } from 'controllers/send-stories';

// How long we allow a job to run before considering it failed
export const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for regular jobs
export const PAGINATED_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // half the time for paginated requests

const COOLDOWN_HOURS = { free: 12, premium: 2, admin: 0 };

function formatEta(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

export async function getQueueStatusForUser(telegram_id: string, locale = 'en'): Promise<string> {
  const jobId = await findPendingJobFx(telegram_id);
  if (!jobId) {
    return t(locale, 'queue.empty');
  }
  const { position, eta } = await getQueueStatsFx(jobId);
  return t(locale, 'queue.position', { position, eta: formatEta(eta) });
}

function getCooldownHours({ isPremium, isAdmin }: { isPremium?: boolean; isAdmin?: boolean }) {
  if (isAdmin) return COOLDOWN_HOURS.admin;
  if (isPremium) return COOLDOWN_HOURS.premium;
  return COOLDOWN_HOURS.free;
}

export async function handleNewTask(user: UserInfo) {
  const { chatId: telegram_id, link: target_username, nextStoriesIds } = user;
  const is_admin = telegram_id === BOT_ADMIN_ID.toString();
  const cooldown = getCooldownHours({ isPremium: user.isPremium, isAdmin: is_admin });

  try {
    const isPaginatedRequest = Array.isArray(nextStoriesIds) && nextStoriesIds.length > 0;

    if (!is_admin && !isPaginatedRequest) {
      const recent = await countRecentUserRequestsFx({ telegram_id, window: 60 });
      if (recent >= 5) {
        await sendTemporaryMessage(
          bot,
          telegram_id,
          t(user.locale, 'queue.rateLimit'),
        );
        return;
      }

      const pending = await countPendingJobsFx(telegram_id);
      if (pending >= 3) {
        await sendTemporaryMessage(
          bot,
          telegram_id,
          t(user.locale, 'queue.pendingLimit'),
        );
        return;
      }

      await recordUserRequestFx(telegram_id);
    }

    if (!isPaginatedRequest) {
      if (await wasRecentlyDownloadedFx({ telegram_id, target_username, hours: cooldown })) {
        const remaining = await getDownloadCooldownRemainingFx({ telegram_id, target_username, hours: cooldown });
        const h = Math.floor(remaining / 3600);
        const m = Math.floor((remaining % 3600) / 60);
        await sendTemporaryMessage(
          bot,
          telegram_id,
          t(user.locale, 'queue.cooldown', { user: target_username, hours: cooldown, h, m }),
        );
        return;
      }
    }

    if (await isDuplicatePendingFx({ telegram_id, target_username, nextStoriesIds })) {
      await sendTemporaryMessage(
        bot,
        telegram_id,
        t(user.locale, 'queue.already')
      );
      return;
    }

    const jobDetails: UserInfo = {
      ...user,
      storyRequestType: Array.isArray(nextStoriesIds) && nextStoriesIds.length > 0
        ? 'paginated'
        : user.storyRequestType,
      isPaginated: Array.isArray(nextStoriesIds) && nextStoriesIds.length > 0,
    };

    const delaySeconds = isPaginatedRequest ? 60 : 0;

    const jobId = await enqueueDownloadFx({
      telegram_id,
      target_username,
      task_details: jobDetails,
      delaySeconds,
    });
    const { position, eta } = await getQueueStatsFx(jobId);
    await sendTemporaryMessage(
      bot,
      telegram_id,
      t(user.locale, 'queue.enqueued', { user: target_username, position, eta: formatEta(eta) }),
    );
    
    setImmediate(processQueue);
  } catch(e: any) {
    console.error('[handleNewTask] Error during task validation/enqueueing:', e);
      await bot.telegram.sendMessage(telegram_id, t(user.locale, 'queue.enqueueError'));
  }
}

let isProcessing = false;

export async function processQueue() {
  if (isProcessing) {
    return;
  }

  const job: DownloadQueueItem | null = await getNextQueueItemFx();
  
  if (!job) {
    console.log('[QueueManager] Queue is empty. Processor is idle.');
    return;
  }

  isProcessing = true;
  await markProcessingFx(job.id);

  const currentTask: UserInfo = { ...job.task, chatId: job.chatId, instanceId: job.id };

  let timedOut = false;
  const timeoutMs = currentTask.storyRequestType === 'paginated'
    ? PAGINATED_PROCESSING_TIMEOUT_MS
    : PROCESSING_TIMEOUT_MS;

  const timeoutId = setTimeout(async () => {
    timedOut = true;
    await markErrorFx({ jobId: job.id, message: 'Processing timeout' });
    await sendTemporaryMessage(
      bot,
      job.chatId,
      t(currentTask.locale, 'queue.processingTimeout', { user: currentTask.link })
    );
    isProcessing = false;
    setImmediate(processQueue);
  }, timeoutMs);

  try {
    console.log(`[QueueManager] Starting processing for ${currentTask.link} (Job ID: ${job.id})`);
    
    const storiesResult = currentTask.storyRequestType === 'archived'
      ? await getArchivedStoriesFx(currentTask)
      : currentTask.linkType === 'username'
        ? await getAllStoriesFx(currentTask)
        : await getParticularStoryFx(currentTask);

    if (typeof storiesResult === 'string') {
      throw new Error(storiesResult);
    }

    const payload: SendStoriesFxParams = { task: currentTask, ...(storiesResult as object) };
    if (!timedOut) {
      await sendStoriesFx(payload);
      await markDoneFx(job.id);
      console.log(`[QueueManager] Finished processing for ${currentTask.link} (Job ID: ${job.id})`);
    }

  } catch (err: any) {
    if (!timedOut) {
      console.error(`[QueueManager] Error processing job ${job.id} for ${currentTask.link}:`, err);
      await markErrorFx({ jobId: job.id, message: err?.message || 'Unknown processing error' });
      await bot.telegram.sendMessage(
        job.chatId,
        t(currentTask.locale, 'queue.processingError', {
          user: currentTask.link,
          reason: err?.message || 'Unknown error',
        })
      );
    }
  } finally {
    clearTimeout(timeoutId);
    if (!timedOut) {
      isProcessing = false;
      await cleanupQueueFx();
      await runMaintenanceFx();
      setImmediate(processQueue);
    } else {
      await cleanupQueueFx();
      await runMaintenanceFx();
    }
  }
}
