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

// =============================================================================
// BUG FIX: The "Duplicate Message" issue was caused by sending multiple status
// updates. The fix is to send ONE initial message ("Fetching...") and then EDIT
// that same message with the final result (counts or error). This provides a
// cleaner UX and makes duplication impossible.
// =============================================================================


export const getAllStoriesFx = createEffect(async (task: UserInfo) => {
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
      // This path handles pagination clicks, which is a different flow.
      const paginatedStoriesResult = await client.invoke(
        new Api.stories.GetStoriesByID({ peer: entity, id: task.nextStoriesIds })
      );
      return paginatedStoriesResult.stories.length > 0
        ? { activeStories: [], pinnedStories: [], paginatedStories: paginatedStoriesResult.stories }
        : '🚫 Specified stories not found!';
    }

    const [activeResult, pinnedResult] = await Promise.all([
      client.invoke(new Api.stories.GetPeerStories({ peer: entity })),
      client.invoke(new Api.stories.GetPinnedStories({ peer: entity }))
    ]);
    
    let activeStories: Api.TypeStoryItem[] = activeResult.stories.stories || [];
    let pinnedStories: Api.TypeStoryItem[] = pinnedResult.stories || [];

    if (activeStories.length > 0 && pinnedStories.length > 0) {
      pinnedStories = pinnedStories.filter(p => !activeStories.some(a => a.id === p.id));
    }
    
    console.log(`[GetStories] Initial fetch for ${task.link}: ${activeStories.length} active, ${pinnedStories.length} initial pinned.`);

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
      
      if (statusMessageId) {
        // Edit the "Fetching..." message with the final counts.
        await bot.telegram.editMessageText(task.chatId, statusMessageId, undefined, summaryText).catch(() => {
            bot.telegram.sendMessage(task.chatId, summaryText).then(({message_id}) => tempMessageSent(message_id));
        });
      } else {
        bot.telegram.sendMessage(task.chatId, summaryText).then(({message_id}) => tempMessageSent(message_id));
      }

      notifyAdmin({ status: 'info', baseInfo: summaryText });
      return { activeStories, pinnedStories };
    }

    return '🚫 No stories found (active or pinned)!';
  } catch (error: any) {
    console.error(`[GetStories] Error in getAllStoriesFx for task ${task.link}:`, error);
    if (statusMessageId) {
        await bot.telegram.editMessageText(task.chatId, statusMessageId, undefined, `❌ An error occurred while fetching story lists.`).catch(() => {});
    }
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

// =============================================================================
// BUG FIX: Re-added the export for getParticularStoryFx which was missing.
// Also applied the "send then edit" message pattern for consistency.
// =============================================================================
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
