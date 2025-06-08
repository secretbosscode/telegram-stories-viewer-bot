// src/controllers/send-stories.ts

import { createEffect } from 'effector';
import { timeout } from 'lib';
import { sendTemporaryMessage } from 'lib/helpers';
import { Api } from 'telegram';
import { bot } from 'index'; // Import the bot instance for sending messages

// Types are correctly imported from a central file.
import {
  UserInfo,
  SendStoriesFxParams,
  SendStoriesArgs,
  SendPaginatedStoriesArgs,
  SendParticularStoryArgs,
  MappedStoryItem
} from 'types';

// Downstream controller functions are imported.
import { sendActiveStories } from 'controllers/send-active-stories';
import { sendPaginatedStories } from 'controllers/send-paginated-stories';
import { sendParticularStory } from 'controllers/send-particular-story';
import { sendPinnedStories } from 'controllers/send-pinned-stories';
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
      paginatedStories,
      particularStory,
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
        }
      }

      // =========================================================================
      // FINAL FIX: Provide clear feedback to the user based on what happened.
      // This solves the "confusing silence" problem.
      // =========================================================================
      if (storiesWereSent) {
        // If we actually sent one or more stories, send the completion message.
        await sendTemporaryMessage(bot, task.chatId, `🎉 Download for ${task.link} completed!`);
      } else {
        // If we went through all the logic and sent nothing, inform the user.
        await bot.telegram.sendMessage(task.chatId, `🤷 No public stories found for ${task.link}.`);
      }

    } catch (error: any) {
      console.error(`[sendStoriesFx] Unhandled error during task for link "${params.task.link}" (User: ${params.task.chatId}):`, error);
      // Re-throw the error so the main service can catch it with .fail.watch()
      // and mark the task as failed in the database.
      throw error;
    }
  }
);
