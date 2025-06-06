// In: controllers/get-stories.ts

import { Userbot } from 'config/userbot';
import { createEffect } from 'effector';
import { bot } from 'index';
import { timeout } from 'lib';

// Fix: Import from the new types location, not stories-service!
import { UserInfo } from '../db/types'; // Adjust as needed
// Remove tempMessageSent import from 'services/stories-service'
// Instead, bring it in from a central events file or replace with your new event mechanism if moved

import { Api } from 'telegram';
import { FloodWaitError } from 'telegram/errors';
import { isDevEnv } from 'config/env-config';

import { notifyAdmin } from './send-message';

// NOTE: If you need to call tempMessageSent, you can either move that event to a central file (recommended),
// or, if you don't use Effector events anymore, replace it with your own tracking logic, or just remove these calls.

import { tempMessageSent } from '../services/events'; // If you moved the event, update this path

// =========================================================================
// This effect fetches all stories for a given user.
// It is responsible for giving the initial feedback to the user.
// =========================================================================
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

  // This is the main logic block for fetching stories.
  try {
    const client = await Userbot.getInstance();
    const entity = await client.getEntity(task.link);
    notifyAdmin({ task, status: 'start' });

    // This path handles pagination clicks from inline buttons.
    if (task.nextStoriesIds) {
      const paginatedStoriesResult = await client.invoke(
        new Api.stories.GetStoriesByID({ peer: entity, id: task.nextStoriesIds })
      );
      return paginatedStoriesResult.stories.length > 0
        ? { activeStories: [], pinnedStories: [], paginatedStories: paginatedStoriesResult.stories }
        : '🚫 Specified stories not found!';
    }

    // This is the main path for a new username request.
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

    // Logic for paginating through all pinned stories for a new request.
    if (!task.nextStoriesIds) {
      let lastPinnedStoryId: number | null = pinnedStories.length > 0 ? pinnedStories[pinnedStories.length - 1].id : null;
      let fetchedCountInLoop = 0;
      while (lastPinnedStoryId !== null) {
        await timeout(1000);
        const olderPinnedResult = await client.invoke(
          new Api.stories.GetPinnedStories({ peer: entity, offsetId: lastPinnedStoryId })
        ).catch(() => null);

        if (olderPinnedResult && olderPinnedResult.stories.length > 0) {
          const newPinnedStories = olderPinnedResult.stories.filter(
            newStory => !activeStories.some(aS => aS.id === newStory.id) && !pinnedStories.some(pS => pS.id === newStory.id)
          );
          if (newPinnedStories.length > 0) {
            pinnedStories.push(...newPinnedStories);
            lastPinnedStoryId = newPinnedStories[newPinnedStories.length - 1].id;
            fetchedCountInLoop += newPinnedStories.length;
          } else {
            lastPinnedStoryId = null;
          }
        } else {
          lastPinnedStoryId = null;
        }
        if (fetchedCountInLoop > 500 && isDevEnv) {
          console.warn("[GetStories] DEV MODE: Safety break in pagination loop.");
          break;
        }
      }
      console.log(`[GetStories] Total pinned stories after pagination for ${task.link}: ${pinnedStories.length}`);
    }

    if (activeStories.length > 0 || pinnedStories.length > 0) {
      const summaryText = `⚡️ ${activeStories.length} Active story items found.\n📌 ${pinnedStories.length} Pinned story items found.`;

      // Here we edit the original message with the final counts.
      if (statusMessageId) {
        await bot.telegram.editMessageText(task.chatId, statusMessageId, undefined, summaryText).catch(() => {
          bot.telegram.sendMessage(task.chatId, summaryText).then(({message_id}) => tempMessageSent(message_id));
        });
      } else {
        bot.telegram.sendMessage(task.chatId, summaryText).then(({message_id}) => tempMessageSent(message_id));
      }

      // Do not notify admin here to avoid duplicate notifications.
      return { activeStories, pinnedStories };
    }

    // If no stories are found, return a user-friendly message string.
    return '🚫 No stories found (active or pinned)!';
  } catch (error: any) {
    // This is the main error handler for this effect.
    console.error(`[GetStories] Error in getAllStoriesFx for task ${task.link}:`, error);
    if (statusMessageId) {
      // Update the user's status message to show an error occurred.
      await bot.telegram.editMessageText(task.chatId, statusMessageId, undefined, `❌ An error occurred while fetching story lists.`).catch(() => {});
    }

    // Return a user-friendly error string that will be handled in stories-service.ts
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

// ------------------------------------------------------------------------
// Fetch a particular story from a link like t.me/username/s/123
// ------------------------------------------------------------------------
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
    const client = await Userbot.getInstance();
    const linkPaths = task.link.split('/');
    if (linkPaths.length < 4 || linkPaths[linkPaths.length-2] !== 's') {
      return '🚫 Invalid story link format. Expected format: t.me/username/s/id';
    }
    const storyId = Number(linkPaths.at(-1));
    const usernameOrChannelId = linkPaths.at(-3);

    if (!usernameOrChannelId || isNaN(storyId)) {
      return '🚫 Invalid story link. Could not parse username/channel or story ID.';
    }

    console.log(`[GetStories] Fetching particular story for ${usernameOrChannelId}, story ID: ${storyId}`);
    const entity = await client.getEntity(usernameOrChannelId);

    const storyData = await client.invoke(
      new Api.stories.GetStoriesByID({ id: [storyId], peer: entity })
    );

    if (storyData.stories.length === 0) {
      return `🚫 Story with ID ${storyId} not found for "${usernameOrChannelId}"!`;
    }

    const summaryText = '✅ Story found successfully! Preparing to send...';
    if (statusMessageId) {
      await bot.telegram.editMessageText(task.chatId, statusMessageId, undefined, summaryText).catch(()=>{});
    } else {
      await bot.telegram.sendMessage(task.chatId, summaryText).then(({message_id}) => tempMessageSent(message_id));
    }

    notifyAdmin({ task, status: 'start' });

    return {
      activeStories: [],
      pinnedStories: [],
      particularStory: storyData.stories[0],
    };
  } catch (error: any) {
    console.error(`[GetStories] ERROR in getParticularStoryFx for ${task.link}:`, error);
    if (statusMessageId) {
      await bot.telegram.editMessageText(task.chatId, statusMessageId, undefined, `❌ An error occurred while fetching this story.`).catch(() => {});
    }
    if (error instanceof FloodWaitError) {
      const seconds = error.seconds || 60;
      return `⚠️ Too many requests. Please wait about ${Math.ceil(seconds / 60)} minute(s).`;
    }
    if (error.message?.includes('No user corresponding to')) {
      return `🚫 User/Channel for story link "${task.link}" not found.`;
    }
    return `🚫 Error fetching specific story: ${task.link}. Link might be invalid or story deleted.`;
  }
});
