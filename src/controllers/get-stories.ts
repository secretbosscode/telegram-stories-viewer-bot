import { Userbot } from 'config/userbot';
import { createEffect } from 'effector';
import { bot } from 'index';
import { timeout } from 'lib';
import { tempMessageSent, UserInfo } from 'services/stories-service';
import { Api } from 'telegram';
import { FloodWaitError } from 'telegram/errors';
import { isDevEnv } from 'config/env-config'; // Import isDevEnv

import { notifyAdmin } from './send-message';

export const getAllStoriesFx = createEffect(async (task: UserInfo) => {
  try {
    const client = await Userbot.getInstance();
    // Note: task.link might still contain "@" if not sanitized upstream.
    // client.getEntity should ideally receive a clean username or ID.
    const entity = await client.getEntity(task.link);

    bot.telegram
      .sendMessage(task.chatId, '⏳ Fetching story lists...')
      .then(({ message_id }) => {
        tempMessageSent(message_id);
        // Reverted status to 'start'
        notifyAdmin({ task, status: 'start' });
      })
      .catch(() => null);

    // Handle paginated stories directly if nextStoriesIds is present
    if (task.nextStoriesIds) {
      console.log('[GetStories] Fetching specific paginated stories by ID for:', task.link);
      const paginatedStoriesResult = await client.invoke(
        new Api.stories.GetStoriesByID({
          peer: entity,
          id: task.nextStoriesIds,
        })
      );

      if (paginatedStoriesResult.stories.length > 0) {
        return {
          activeStories: [],
          pinnedStories: [],
          paginatedStories: paginatedStoriesResult.stories,
        };
      }
      return '🚫 Specified stories not found!';
    }

    // Fetch initial active and pinned stories metadata in parallel
    console.log('[GetStories] Getting initial active and pinned stories metadata in parallel for:', task.link);
    const [activeResult, pinnedResult] = await Promise.all([
      client.invoke(new Api.stories.GetPeerStories({ peer: entity })),
      client.invoke(new Api.stories.GetPinnedStories({ peer: entity }))
    ]);
    // Removed the timeout(1000) that was between these calls.

    let activeStories: Api.TypeStoryItem[] = activeResult.stories.stories || [];
    let pinnedStories: Api.TypeStoryItem[] = pinnedResult.stories || []; // Assuming pinnedResult.stories is the array

    // Filter out active stories from the initial pinned list to avoid duplicates
    if (activeStories.length > 0 && pinnedStories.length > 0) {
        pinnedStories = pinnedStories.filter(
            (pinnedStory) => !activeStories.some((activeStory) => activeStory.id === pinnedStory.id)
        );
    }
    
    console.log(`[GetStories] Initial fetch for ${task.link}: ${activeStories.length} active, ${pinnedStories.length} initial pinned.`);

    // If fetching for the first time (not a paginated request for a specific set of IDs),
    // then paginate through all older pinned stories.
    // The original logic for paginating pinned stories remains sequential as each call depends on the previous offset.
    if (!task.nextStoriesIds) {
      let lastPinnedStoryId: number | null = pinnedStories.length > 0 ? pinnedStories[pinnedStories.length - 1].id : null;
      let fetchedCountInLoop = 0;

      // Loop to get all older pinned stories
      while (lastPinnedStoryId !== null) {
        console.log(`[GetStories] Fetching older pinned stories for ${task.link}, offset ID: ${lastPinnedStoryId}`);
        await timeout(1000); // Keep a polite delay between paginated calls

        const olderPinnedResult = await client
          .invoke(
            new Api.stories.GetPinnedStories({
              peer: entity, // Use the resolved entity
              offsetId: lastPinnedStoryId,
              // limit: 100, // You can specify a limit if desired
            })
          )
          .catch((err) => {
            console.error(`[GetStories] Error fetching older pinned stories for ${task.link} with offset ${lastPinnedStoryId}:`, err.message);
            return null; // Allow the loop to terminate gracefully on error
          });

        if (olderPinnedResult && olderPinnedResult.stories.length > 0) {
          const newPinnedStories = olderPinnedResult.stories.filter(
            (newStory) => !activeStories.some((activeStory) => activeStory.id === newStory.id) &&
                           !pinnedStories.some((existingPinned) => existingPinned.id === newStory.id)
          );

          if (newPinnedStories.length > 0) {
            pinnedStories.push(...newPinnedStories);
            lastPinnedStoryId = newPinnedStories[newPinnedStories.length - 1].id;
            fetchedCountInLoop += newPinnedStories.length;
          } else {
            // No new unique stories found in this batch, or all were duplicates of active
            lastPinnedStoryId = null; // Stop pagination
          }
        } else {
          // No more stories or an error occurred
          lastPinnedStoryId = null; // Stop pagination
        }
        if (fetchedCountInLoop > 500 && isDevEnv) { // Safety break for dev to prevent accidental long loops
            console.warn("[GetStories] DEV MODE: Safety break in pinned stories pagination loop after 500+ fetched.");
            break;
        }
      }
      console.log(`[GetStories] Total pinned stories after pagination for ${task.link}: ${pinnedStories.length}`);
    }

    if (activeStories.length > 0 || pinnedStories.length > 0) {
      const text =
        `⚡️ ${activeStories.length} Active story items found.\n` +
        `📌 ${pinnedStories.length} Pinned story items found.`;
      bot.telegram
        .sendMessage(task.chatId, text)
        .then(({ message_id }) => {
          tempMessageSent(message_id);
          // Reverted status to 'info'
          notifyAdmin({
            status: 'info', 
            baseInfo: text,
          });
        })
        .catch(() => null);
      return { activeStories, pinnedStories };
    }

    return '🚫 No stories found (active or pinned)!';
  } catch (error: any) {
    console.error(`[GetStories] Error in getAllStoriesFx for task ${task.link}:`, error);
    if (error instanceof FloodWaitError || (error.errorMessage && error.errorMessage.startsWith('FLOOD_WAIT_'))) {
        const seconds = error.seconds || parseInt(error.errorMessage?.split('_').pop() || "60");
      return (
        `⚠️ Too many requests. Please wait about ${Math.ceil(seconds / 60)} minute(s) before trying again.\n` +
        `(You can use the /schedule command for later.)`
      );
    }

    if (task.link.startsWith('+')) {
      return '⚠️ If a user keeps their phone number private, the bot cannot access their stories.';
    }
    // More specific error messages based on error type can be added here
    // e.g., checking for 'USERNAME_NOT_OCCUPIED', 'PEER_ID_INVALID' etc.
    if (error.message?.includes('No user corresponding to')) {
        return `🚫 User "${task.link}" not found. Please check the username.`;
    }

    return `🚫 Error fetching stories for "${task.link}". The user may not exist, have no stories, or there might be a temporary issue.`;
  }
});

export const getParticularStoryFx = createEffect(async (task: UserInfo) => {
  try {
    const client = await Userbot.getInstance();
    const linkPaths = task.link.split('/');
    // Basic validation for story URL format: t.me/username/s/story_id
    if (linkPaths.length < 4 || linkPaths[linkPaths.length-2] !== 's') {
        return '🚫 Invalid story link format. Expected format: t.me/username/s/id';
    }
    const storyId = Number(linkPaths.at(-1));
    const usernameOrChannelId = linkPaths.at(-3); // This is the entity identifier

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

    const text = '⚡️ Story found successfully! Preparing to send...';
    bot.telegram
      .sendMessage(task.chatId!, text)
      .then(({ message_id }) => {
        tempMessageSent(message_id);
        // Reverted status to 'start'
        notifyAdmin({ task, status: 'start' }); 
      })
      .catch(() => null);

    return {
      activeStories: [],
      pinnedStories: [],
      particularStory: storyData.stories[0],
    };
  } catch (error: any) {
    console.error(`[GetStories] ERROR in getParticularStoryFx for ${task.link}:`, error);
     if (error instanceof FloodWaitError || (error.errorMessage && error.errorMessage.startsWith('FLOOD_WAIT_'))) {
        const seconds = error.seconds || parseInt(error.errorMessage?.split('_').pop() || "60");
      return (
        `⚠️ Too many requests. Please wait about ${Math.ceil(seconds / 60)} minute(s) before trying again.`
      );
    }
    if (error.message?.includes('No user corresponding to')) {
        return `🚫 User/Channel for story link "${task.link}" not found.`;
    }
    return `🚫 Error fetching specific story: ${task.link}. Link might be invalid or story deleted.`;
  }
});
