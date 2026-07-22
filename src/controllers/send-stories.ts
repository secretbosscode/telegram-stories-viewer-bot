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

    // A paused paywall is a closed paywall, not free mode. This second guard
    // protects requests already in the queue when the administrator pauses
    // Stars after discovery has started.
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

    // Place the Stars boundary after verified discovery and before media.
    if (await maybeOfferStoryUnlock(params)) {
      return;
    }

    let storiesWereSent = false;

    try {
      if (particularStory) {
        await sendParticularStory({ story: particularStory, task });
        storiesWereSent = true;
      }
      else if (paginatedStories && paginatedStories.length > 0) {
        const deliveredCount = await sendPaginatedStories({
          stories: paginatedStories,
          task,
        });
        storiesWereSent = deliveredCount > 0;
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
          await sendActiveStories({ stories: mappedActiveStories, task });
          storiesWereSent = true;
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

      if (storiesWereSent) {
        if (task.starsBundleId) {
          markStarsBundleDelivered(task.starsBundleId);
        }
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
      else if (task.starsBundleId) {
        // The user paid for exact IDs. If neither media nor a valid exported
        // fallback was delivered, refund instead of declaring success.
        await refundUndeliverableStarsBundle(task.starsBundleId);
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
