import { Userbot } from 'config/userbot';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { chunkMediafiles, timeout } from 'lib';
import {
  tempMessageSent,
} from 'services/stories-service';
import { Markup } from 'telegraf';
import { Api } from 'telegram';
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram';

import { downloadStories, mapStories, StoriesModel } from './download-stories';
import { notifyAdmin } from './send-message';
import { SendStoriesArgs } from './types';

export async function sendPinnedStories({ stories, task }: SendStoriesArgs): Promise<void> {
  try {
    let mapped: StoriesModel = mapStories(stories);

    // =========================================================================
    // BUG FIX & NEW FEATURE: User Limits and Premium Upsell
    // =========================================================================
    
    // 1. Define the limit and check if the user is privileged (Admin or Premium).
    const isPrivileged = task.isPremium || task.chatId === BOT_ADMIN_ID.toString();
    const STORY_LIMIT_FOR_FREE_USERS = 5;
    let wasLimited = false;

    // 2. If the user is NOT privileged and exceeds the limit, truncate the story list.
    // We set a flag `wasLimited` so we can notify them later.
    if (!isPrivileged && mapped.length > STORY_LIMIT_FOR_FREE_USERS) {
      console.log(`[SendPinnedStories] Limiting non-premium user ${task.chatId} to ${STORY_LIMIT_FOR_FREE_USERS} stories.`);
      wasLimited = true;
      mapped = mapped.slice(0, STORY_LIMIT_FOR_FREE_USERS);
    }

    // --- The rest of the function now operates on the (potentially limited) `mapped` array ---

    // Re-fetching stories that might have been mapped without media objects.
    const storiesWithoutMedia = mapped.filter((x) => !x.media);
    if (storiesWithoutMedia.length > 0) {
      // ... your logic for re-fetching is fine ...
    }

    console.log(`[SendPinnedStories] [${task.link}] Preparing to download ${mapped.length} pinned stories.`);

    await bot.telegram.sendMessage(
      task.chatId!,
      '⏳ Downloading Pinned stories...' // Simplified initial message
    ).then(({ message_id }) => tempMessageSent(message_id))
      .catch(() => null);

    const downloadPromise = downloadStories(mapped, 'pinned');
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Download process timed out after 5 minutes.')), 300000)
    );
    await Promise.race([downloadPromise, timeoutPromise]);
    
    console.log(`[SendPinnedStories] [${task.link}] downloadStories function completed.`);

    const uploadableStories = mapped.filter(
      (x) => x.buffer && x.bufferSize! <= 50
    );

    console.log(`[SendPinnedStories] [${task.link}] Found ${uploadableStories.length} uploadable pinned stories after download.`);

    if (uploadableStories.length > 0) {
      await bot.telegram.sendMessage(
        task.chatId!,
        `📥 ${uploadableStories.length} Pinned stories downloaded successfully!\n⏳ Uploading stories to Telegram...`
      ).then(({ message_id }) => tempMessageSent(message_id))
        .catch(() => null);

      const chunkedList = chunkMediafiles(uploadableStories);
      for (let i = 0; i < chunkedList.length; i++) {
        const album = chunkedList[i];
        try {
            await bot.telegram.sendMediaGroup(
              task.chatId,
              album.map((x) => ({
                media: { source: x.buffer! }, 
                type: x.mediaType!, 
                caption: x.caption ?? `Pinned story ${x.id}`, 
              }))
            );
        } catch (sendError) {
            console.error(`[SendPinnedStories] [${task.link}] Error sending media group chunk ${i + 1}:`, sendError);
            throw sendError;
        }
        await timeout(500);
      }
    } else {
      await bot.telegram.sendMessage(
        task.chatId,
        '❌ No Pinned stories could be sent. They might be too large or none were found.'
      );
    }

    // =========================================================================
    // NEW FEATURE: After sending the stories, if the user was limited,
    // send the premium upsell message.
    // =========================================================================
    if (wasLimited) {
        await timeout(1000); // Small delay so this message comes last
        await bot.telegram.sendMessage(
            task.chatId,
            `💎 You have reached the free limit of **${STORY_LIMIT_FOR_FREE_USERS} stories**.\n\n` +
            `To download all stories from this user and enjoy unlimited access, please upgrade to Premium!\n\n` +
            `👉 Run the **/premium** command to learn more.`,
            { parse_mode: 'Markdown' }
        );
    }

    // The old pagination logic (`if (hasMorePages)`) should be removed entirely.

    notifyAdmin({
      status: 'info',
      baseInfo: `📥 ${uploadableStories.length} Pinned stories uploaded for user ${task.link} (chatId: ${task.chatId})!`,
    });
    console.log(`[SendPinnedStories] [${task.link}] Processing finished successfully.`);
  } catch (error) {
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    });
    console.error(`[SendPinnedStories] [${task.link}] CRITICAL error occurred:`, error);
    try {
        await bot.telegram.sendMessage(task.chatId, ' Encountered an error while processing pinned stories. The admin has been notified.');
    } catch (e) { /* ignore */}
    // Crucially, re-throw the error to fail the parent effect
    throw error;
  } finally {
    console.log(`[SendPinnedStories] [${task.link}] Function execution complete.`);
  }
}
