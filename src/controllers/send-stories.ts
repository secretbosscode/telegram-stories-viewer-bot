// src/controllers/send-stories.ts

import { createEffect } from 'effector';
import { timeout } from 'lib';
import { sendTemporaryMessage } from 'lib/helpers';
import { t } from 'lib/i18n';
import { bot } from 'index';
import { notifyAdmin } from 'controllers/send-message';
import { BOT_ADMIN_ID } from 'config/env-config';

import {
  SendStoriesFxParams,
  MappedStoryItem,
  NotifyAdminParams,
} from 'types';

import { sendActiveStories } from 'controllers/send-active-stories';
import { sendPaginatedStories } from 'controllers/send-paginated-stories';
import { sendParticularStory } from 'controllers/send-particular-story';
import { sendPinnedStories } from 'controllers/send-pinned-stories';
import { sendGlobalStories } from 'controllers/send-global-stories';
import { sendArchivedStories } from 'controllers/send-archived-stories';
import { mapStories } from 'controllers/download-stories';
import {
  areStarsEnabled,
  isStarsMode,
  markStarsBundleDelivered,
  maybeOfferStoryUnlock,
  recordStarsDeliveryFailure,
  refundUndeliverableStarsBundle,
} from 'services/stars-payment';

function uniqueIds(ids: number[] | undefined): number[] {
  return [...new Set((ids ?? []).map(Number).filter(Number.isFinite))];
}

function paidBundleWasFullyDelivered(
  expectedIds: number[] | undefined,
  deliveredIds: number[],
): boolean {
  const expected = uniqueIds(expectedIds);
  if (expected.length === 0) return false;
  const delivered = new Set(uniqueIds(deliveredIds));
  return expected.every((storyId) => delivered.has(storyId));
}

/**
 * Main story-delivery orchestrator. Discovery remains free in Stars mode, but
 * non-Premium media is never delivered unless an invoice was paid.
 */
export const sendStoriesFx = createEffect<SendStoriesFxParams, void, Error>(
  async (params) => {
    const {
      activeStories = [],
      pinnedStories = [],
      archivedStories = [],
      paginatedStories,
      particularStory,
      globalStories,
      globalStoryOwnersById,
      task,
    } = params;

    const requesterId = String(task.user?.id ?? task.chatId);
    const isAdmin = requesterId === String(BOT_ADMIN_ID);

    if (
      isStarsMode() &&
      !areStarsEnabled() &&
      !task.starsUnlocked &&
      !task.isPremium &&
      !isAdmin &&
      task.storyRequestType !== 'archived' &&
      task.storyRequestType !== 'global' &&
      task.storyRequestType !== 'paginated'
    ) {
      await bot.telegram.sendMessage(
        task.chatId,
        t(task.locale, 'stars.paymentUnavailable'),
      );
      return;
    }

    if (await maybeOfferStoryUnlock(params)) {
      return;
    }

    let storiesWereSent = false;
    let deliveredStoryIds: number[] = [];

    try {
      if (particularStory) {
        await sendParticularStory({ story: particularStory, task });
        deliveredStoryIds = [particularStory.id];
        storiesWereSent = true;
      }
      else if (paginatedStories && paginatedStories.length > 0) {
        deliveredStoryIds = await sendPaginatedStories({
          stories: paginatedStories,
          task,
        });
        storiesWereSent = deliveredStoryIds.length > 0;
      }
      else if (globalStories && globalStories.length > 0) {
        const mappedGlobalStories: MappedStoryItem[] = mapStories(
          globalStories,
          globalStoryOwnersById,
        );
        await sendGlobalStories({
          stories: mappedGlobalStories,
          task,
          storyOwnersById: globalStoryOwnersById,
        });
        storiesWereSent = true;
      }
      else {
        if (activeStories.length > 0) {
          const mappedActiveStories: MappedStoryItem[] = mapStories(activeStories);
          const activeDeliveredIds = await sendActiveStories({
            stories: mappedActiveStories,
            task,
          });
          deliveredStoryIds.push(...activeDeliveredIds);
          storiesWereSent = storiesWereSent || activeDeliveredIds.length > 0;
          await timeout(2000);
        }

        if (pinnedStories.length > 0) {
          const mappedPinnedStories: MappedStoryItem[] = mapStories(pinnedStories);
          await sendPinnedStories({ stories: mappedPinnedStories, task });
          storiesWereSent = true;
          await timeout(2000);
        }

        if (archivedStories.length > 0) {
          const mappedArchivedStories: MappedStoryItem[] = mapStories(archivedStories);
          await sendArchivedStories({ stories: mappedArchivedStories, task });
          storiesWereSent = true;
        }
      }

      if (task.starsBundleId) {
        const complete = paidBundleWasFullyDelivered(
          task.starsExpectedStoryIds,
          deliveredStoryIds,
        );
        if (!complete) {
          const expected = uniqueIds(task.starsExpectedStoryIds);
          const delivered = uniqueIds(deliveredStoryIds);
          recordStarsDeliveryFailure(
            task.starsBundleId,
            new Error(
              `Incomplete paid delivery: ${delivered.length}/${expected.length} expected stories delivered`,
            ),
          );
          // Do not leave a customer charged for a partial result bundle. A full
          // refund is safer than finalizing incomplete fulfillment or retrying
          // already-delivered media and creating duplicates.
          await refundUndeliverableStarsBundle(task.starsBundleId);
          return;
        }
        markStarsBundleDelivered(task.starsBundleId);
      }

      if (storiesWereSent) {
        await bot.telegram.sendMessage(
          task.chatId,
          t(task.locale, 'stories.completed', { link: task.link }),
          { link_preview_options: { is_disabled: true } },
        );
        notifyAdmin({
          status: 'info',
          task,
          baseInfo: `📥 Stories sent for ${task.link} (chatId: ${task.chatId})`,
        } as NotifyAdminParams);
      }
      else {
        await sendTemporaryMessage(
          bot,
          task.chatId,
          t(task.locale, 'stories.noneFound', { link: task.link }),
          { link_preview_options: { is_disabled: true } },
        );
        notifyAdmin({
          status: 'info',
          task,
          baseInfo: `ℹ️ No stories found for ${task.link} (chatId: ${task.chatId})`,
        } as NotifyAdminParams);
      }
    }
    catch (error: any) {
      if (task.starsBundleId) {
        recordStarsDeliveryFailure(task.starsBundleId, error);
      }
      console.error(
        `[sendStoriesFx] Unhandled error during task for link "${params.task.link}" (User: ${params.task.chatId}):`,
        error,
      );
      notifyAdmin({
        status: 'error',
        task,
        errorInfo: { cause: error },
      } as NotifyAdminParams);
      throw error;
    }
  },
);
