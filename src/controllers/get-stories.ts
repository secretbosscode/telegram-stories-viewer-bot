// In: controllers/get-stories.ts

import { Userbot } from 'config/userbot';
import { createEffect } from 'effector';
import { bot } from 'index';
import { timeout } from 'lib';
import { tempMessageSent, UserInfo } from 'services/stories-service';
import { Api } from 'telegram';
import { FloodWaitError } from 'telegram/errors';
import { isDevEnv } from 'config/env-config';

import { notifyAdmin } from './send-message';

export const getAllStoriesFx = createEffect(async (task: UserInfo) => {
  // =========================================================================
  // CRITICAL UX PATTERN: Send then Edit
  // DO NOT MODIFY this pattern without careful consideration.
  // -------------------------------------------------------------------------
  // This block sends an initial "working..." message and saves its ID.
  // Later, it EDITS this same message with the final result or an error.
  // This prevents spamming the user with multiple status updates and fixed
  // a bug where duplicate summary messages were being sent.
  // =========================================================================
  let statusMessageId: number | undefined;
  try {
    const sentMessage = await bot.telegram.sendMessage(task.chatId, '⏳ Fetching story lists...');
    statusMessageId = sentMessage.message_id;
    tempMessageSent(statusMessageId);
  } catch (e) {
    console.error(`[GetStories] Could not send initial status message to chat ${task.chatId}`);
  }

  try {
    const client = await Userbot.getInstance();
    const entity = await client.getEntity(task.link);
    notifyAdmin({ task, status: 'start' });

    if (task.nextStoriesIds) {
      // This is the separate logic path for handling pagination button clicks.
      const paginatedStoriesResult = await client.invoke(
        new Api.stories.GetStoriesByID({ peer: entity, id: task.nextStoriesIds })
      );
      return paginatedStoriesResult.stories.length > 0
        ? { activeStories: [], pinnedStories: [], paginatedStories: paginatedStoriesResult.stories }
        : '🚫 Specified stories not found!';
    }

    // This is the main logic path for a new username request.
    const [activeResult, pinnedResult] = await Promise.all([
      client.invoke(new Api.stories.GetPeerStories({ peer: entity })),
      client.invoke(new Api.stories.GetPinnedStories({ peer: entity }))
    ]);
    
    let activeStories: Api.TypeStoryItem[] = activeResult.stories.stories || [];
    let pinnedStories: Api.TypeStoryItem[] = pinnedResult.stories || [];

    // Deduplication logic
    if (activeStories.length > 0 && pinnedStories.length > 0) {
      pinnedStories = pinnedStories.filter(p => !activeStories.some(a => a.id === p.id));
    }
    
    console.log(`[GetStories] Initial fetch for ${task.link}: ${activeStories.length} active, ${pinnedStories.length} initial pinned.`);

    // Pinned story pagination logic
    if (!task.nextStoriesIds) {
      let lastPinnedStoryId: number | null = pinnedStories.length > 0 ? pinnedStories[pinnedStories.length - 1].id : null;
      let fetchedCountInLoop = 0;
      while (lastPinnedStoryId !== null) {
        // ... (your pagination loop logic is here) ...
      }
      console.log(`[GetStories] Total pinned stories after pagination for ${task.link}: ${pinnedStories.length}`);
    }

    if (activeStories.length > 0 || pinnedStories.length > 0) {
      const summaryText = `⚡️ ${activeStories.length} Active story items found.\n📌 ${pinnedStories.length} Pinned story items found.`;
      
      // Here we edit the original message with the final counts.
      if (statusMessageId) {
        await bot.telegram.editMessageText(task.chatId, statusMessageId, undefined, summaryText).catch(() => {
            // Fallback to sending a new message if editing fails
          bot.telegram.sendMessage(task.chatId, summaryText).then(({message_id}) => tempMessageSent(message_id));
        });
      } else {
        // Fallback if the initial message couldn't be sent at all.
        bot.telegram.sendMessage(task.chatId, summaryText).then(({message_id}) => tempMessageSent(message_id));
      }

      // This call was commented out to prevent duplicate messages to the admin.
      // notifyAdmin({ status: 'info', baseInfo: summaryText });

      return { activeStories, pinnedStories };
    }

    return '🚫 No stories found (active or pinned)!';
  } catch (error: any) {
    // This is the main error handler for this effect.
    console.error(`[GetStories] Error in getAllStoriesFx for task ${task.link}:`, error);
    if (statusMessageId) {
      // Update the user's status message to show an error occurred.
        await bot.telegram.editMessageText(task.chatId, statusMessageId, undefined, `❌ An error occurred while fetching story lists.`).catch(() => {});
    }
    
    // Return a user-friendly error message string, which will be handled
    // by the `.doneData` error path in stories-service.ts
    if (error instanceof FloodWaitError) {
      const seconds = error.seconds || 60;
      return `⚠️ Too many requests. Please wait about ${Math.ceil(seconds / 60)} minute(s).`;
    }
    if (error.message?.includes('No user corresponding to')) {
        return `🚫 User "${task.link}" not found. Please check the username.`;
    }
    return `🚫 Error fetching stories for "${task.link}". User may not exist or have public stories.`;
  }
});

// This effect for particular stories follows the same robust pattern.
export const getParticularStoryFx = createEffect(async (task: UserInfo) => {
  let statusMessageId: number | undefined;
  try {
    const sentMessage = await bot.telegram.sendMessage(task.chatId, '⏳ Fetching specific story...');
    statusMessageId = sentMessage.message_id;
    tempMessageSent(statusMessageId);
  } catch (e) {
    console.error(`[GetStories] Could not send initial status message to chat ${task.chatId}`);
  }

  try {
    // ... (rest of the logic for this effect) ...
  } catch (error: any) {
    // ... (error handling for this effect) ...
  }
});
