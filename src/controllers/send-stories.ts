// src/controllers/send-stories.ts

import { createEffect } from 'effector';
import { timeout } from 'lib';
import { sendTemporaryMessage } from 'lib/helpers';
import { t } from "lib/i18n";
import { bot } from 'index'; // Import the bot instance for sending messages
import { notifyAdmin } from 'controllers/send-message';

// Types are correctly imported from a central file.
import {
  SendStoriesFxParams,
  MappedStoryItem,
  NotifyAdminParams,
} from 'types';

// Downstream controller functions are imported.
import { sendActiveStories } from 'controllers/send-active-stories';
import { sendPaginatedStories } from 'controllers/send-paginated-stories';
import { sendParticularStory } from 'controllers/send-particular-story';
import { sendPinnedStories } from 'controllers/send-pinned-stories';
import { sendGlobalStories } from 'controllers/send-global-stories';
import { sendArchivedStories } from 'controllers/send-archived-stories';
import { mapStories } from 'controllers/download-stories';

/**
 * This is the main orchestrator effect for sending stories.
 * It receives a payload with different types of stories and decides which
 * specialized sending function to call. It also handles mapping data
 * and providing final feedback to the user.
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

    // This flag will track if we actually sent any media to the user.
    let storiesWereSent = false;

    try {
      // 1. Handle a request for one specific story. This has the highest priority.
      if (particularStory) {
        await sendParticularStory({ story: particularStory, task });
        storiesWereSent = true;
      } 
      // 2. Handle a request for a "page" of stories (from a "next" button).
      else if (paginatedStories && paginatedStories.length > 0) {
        await sendPaginatedStories({ stories: paginatedStories, task });
        storiesWereSent = true;
      }
      else if (globalStories && globalStories.length > 0) {
        const mappedGlobalStories: MappedStoryItem[] = mapStories(globalStories, globalStoryOwnersById);
        await sendGlobalStories({ stories: mappedGlobalStories, task, storyOwnersById: globalStoryOwnersById });
        storiesWereSent = true;
      }
      // 3. Handle the general case of active and pinned stories.
      else {
        if (activeStories.length > 0) {
          // PROCESS COMMENT: This is a critical fix from your new version. The raw
          // API data must be mapped to our internal MappedStoryItem format.
          const mappedActiveStories: MappedStoryItem[] = mapStories(activeStories);
          await sendActiveStories({ stories: mappedActiveStories, task });
          storiesWereSent = true;
          await timeout(2000); // Wait after sending active stories
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

      // =========================================================================
      // FINAL FIX: Provide clear feedback to the user based on what happened.
      // This solves the "confusing silence" problem.
      // =========================================================================
      if (storiesWereSent) {
        // If we actually sent one or more stories, send the completion message.
        await bot.telegram.sendMessage(
          task.chatId,
          t(task.locale, 'stories.completed', { link: task.link }),
          { link_preview_options: { is_disabled: true } }
        );
        notifyAdmin({
          status: 'info',
          task,
          baseInfo: `📥 Stories sent for ${task.link} (chatId: ${task.chatId})`,
        } as NotifyAdminParams);
      } else {
        // If we went through all the logic and sent nothing, inform the user.
        await sendTemporaryMessage(
          bot,
          task.chatId,
          t(task.locale, 'stories.noneFound', { link: task.link }),
          { link_preview_options: { is_disabled: true } }
        );
        notifyAdmin({
          status: 'info',
          task,
          baseInfo: `ℹ️ No stories found for ${task.link} (chatId: ${task.chatId})`,
        } as NotifyAdminParams);
      }

    } catch (error: any) {
      console.error(`[sendStoriesFx] Unhandled error during task for link "${params.task.link}" (User: ${params.task.chatId}):`, error);
      notifyAdmin({
        status: 'error',
        task,
        errorInfo: { cause: error },
      } as NotifyAdminParams);
      // Re-throw the error so the main service can catch it with .fail.watch()
      // and mark the task as failed in the database.
      throw error;
    }
  }
);
