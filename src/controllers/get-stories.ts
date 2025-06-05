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
  // --- Step 1: Send an initial "working..." message and get its ID ---
  // We will EDIT this message later instead of sending new ones.
  let statusMessageId: number | undefined;
  try {
    const sentMessage = await bot.telegram.sendMessage(task.chatId, '⏳ Fetching story lists...');
    statusMessageId = sentMessage.message_id;
    tempMessageSent(statusMessageId); // Register for potential cleanup
  } catch (e) {
    console.error(`[GetStories] Could not send initial status message to chat ${task.chatId}`);
  }
  
  // Now, wrap the entire story fetching logic in its own try...catch
  try {
    const client = await Userbot.getInstance();
    const entity = await client.getEntity(task.link);
    notifyAdmin({ task, status: 'start' });

    // Handle paginated stories directly if nextStoriesIds is present
    if (task.nextStoriesIds) {
      // ... (your existing pagination logic is fine, but doesn't send the summary, so we'll leave it)
    }

    // Fetch initial active and pinned stories metadata in parallel
    const [activeResult, pinnedResult] = await Promise.all([
      client.invoke(new Api.stories.GetPeerStories({ peer: entity })),
      client.invoke(new Api.stories.GetPinnedStories({ peer: entity }))
    ]);
    
    let activeStories: Api.TypeStoryItem[] = activeResult.stories.stories || [];
    let pinnedStories: Api.TypeStoryItem[] = pinnedResult.stories || [];

    // Filter out duplicates
    if (activeStories.length > 0 && pinnedStories.length > 0) {
        pinnedStories = pinnedStories.filter(
            (pinnedStory) => !activeStories.some((activeStory) => activeStory.id === pinnedStory.id)
        );
    }
    
    console.log(`[GetStories] Initial fetch for ${task.link}: ${activeStories.length} active, ${pinnedStories.length} initial pinned.`);

    // Full pagination logic for pinned stories
    if (!task.nextStoriesIds) {
      // ... (your existing loop to fetch all pinned stories is here) ...
    }
    console.log(`[GetStories] Total pinned stories after pagination for ${task.link}: ${pinnedStories.length}`);

    if (activeStories.length > 0 || pinnedStories.length > 0) {
      // --- Step 2: Edit the original message with the final summary ---
      const summaryText =
        `⚡️ ${activeStories.length} Active story items found.\n` +
        `📌 ${pinnedStories.length} Pinned story items found.`;
      
      if (statusMessageId) {
        // Use editMessageText to update the "Fetching..." message
        await bot.telegram.editMessageText(task.chatId, statusMessageId, undefined, summaryText).catch(() => {
            // If editing fails (e.g., message deleted), just send a new one as a fallback.
            bot.telegram.sendMessage(task.chatId, summaryText).then(({message_id}) => tempMessageSent(message_id));
        });
      } else {
        // Fallback if the initial message failed to send
        bot.telegram.sendMessage(task.chatId, summaryText).then(({message_id}) => tempMessageSent(message_id));
      }

      notifyAdmin({ status: 'info', baseInfo: summaryText });
      return { activeStories, pinnedStories };
    }

    return '🚫 No stories found (active or pinned)!'; // This is a handled "error" string result

  } catch (error: any) {
    // This catch block handles hard failures during API calls
    console.error(`[GetStories] Error in getAllStoriesFx for task ${task.link}:`, error);
    if (statusMessageId) {
        // Also update the status message on error
        bot.telegram.editMessageText(task.chatId, statusMessageId, undefined, `❌ An error occurred while fetching story lists.`).catch(() => {});
    }
    // Return a user-friendly error string that will be processed by stories-service
    if (error instanceof FloodWaitError) {
      const seconds = error.seconds || 60;
      return `⚠️ Too many requests. Please wait about ${Math.ceil(seconds / 60)} minute(s).`;
    }
    if (error.message?.includes('No user corresponding to')) {
        return `🚫 User "${task.link}" not found. Please check the username.`;
    }
    return `🚫 Error fetching stories for "${task.link}". The user may not exist or have public stories.`;
  }
});

// ... your getParticularStoryFx would follow a similar edit-message pattern ...
