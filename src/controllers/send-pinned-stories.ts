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

// =========================================================================
// CRITICAL FUNCTION: This function handles downloading and sending stories.
// It contains essential error handling and business logic for premium users.
// =========================================================================
export async function sendPinnedStories({ stories, task }: SendStoriesArgs): Promise<void> {
  try {
    let mapped: StoriesModel = mapStories(stories);

    // =========================================================================
    // CORE BUSINESS LOGIC: User Limits and Premium Upsell
    // DO NOT MODIFY without considering the impact on free vs. premium tiers.
    // -------------------------------------------------------------------------
    // This block enforces the story limit for non-privileged users.
    // =========================================================================
    const isPrivileged = task.isPremium || task.chatId === BOT_ADMIN_ID.toString();
    const STORY_LIMIT_FOR_FREE_USERS = 5;
    let wasLimited = false;

    if (!isPrivileged && mapped.length > STORY_LIMIT_FOR_FREE_USERS) {
      console.log(`[SendPinnedStories] Limiting non-premium user ${task.chatId} to ${STORY_LIMIT_FOR_FREE_USERS} stories.`);
      wasLimited = true;
      // The story array is truncated here for free users.
      mapped = mapped.slice(0, STORY_LIMIT_FOR_FREE_USERS);
    }

    // Re-fetching stories that might have been mapped without media objects.
    const storiesWithoutMedia = mapped.filter((x) => !x.media);
    if (storiesWithoutMedia.length > 0) {
      // Your existing logic for re-fetching stories by ID
      // This block has its own try/catch and is self-contained.
    }

    console.log(`[SendPinnedStories] [${task.link}] Preparing to download ${mapped.length} pinned stories.`);

    await bot.telegram.sendMessage(
      task.chatId!,
      '⏳ Downloading Pinned stories...'
    ).then(({ message_id }) => tempMessageSent(message_id))
      .catch(() => null);

    // =========================================================================
    // CRITICAL STABILITY LOGIC: Download Timeout
    // DO NOT REMOVE the Promise.race or the timeout.
    // -------------------------------------------------------------------------
    // This prevents the bot from getting stuck indefinitely on a hanging download.
    // If downloadStories() takes more than 5 minutes, it will fail the task.
    // The *best* fix is always to ensure `downloadStories` itself has proper
    // error handling, but this is a vital safety net.
    // =========================================================================
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
            // This throw is important to fail the entire task if one chunk fails.
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

    // This block sends the premium upsell message if the user was limited.
    if (wasLimited) {
        await timeout(1000);
        await bot.telegram.sendMessage(
            task.chatId,
            `💎 You have reached the free limit of **${STORY_LIMIT_FOR_FREE_USERS} stories**.\n\n` +
            `To download all stories from this user and enjoy unlimited access, please upgrade to Premium!\n\n` +
            `👉 Run the **/premium** command to learn more.`,
            { parse_mode: 'Markdown' }
        );
    }

    notifyAdmin({
      status: 'info',
      baseInfo: `📥 ${uploadableStories.length} Pinned stories uploaded for user ${task.link} (chatId: ${task.chatId})!`,
    });
    console.log(`[SendPinnedStories] [${task.link}] Processing finished successfully.`);

  } catch (error) {
    // =========================================================================
    // CRITICAL ERROR HANDLING - DO NOT REMOVE `throw error`
    // -------------------------------------------------------------------------
    // This catch block ensures any failure in this function is propagated up to
    // `sendStoriesFx`. This rejection is essential for Effector's `.fail` event
    // to trigger, which un-sticks the queue and allows the bot to continue.
    // =========================================================================
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    });
    console.error(`[SendPinnedStories] [${task.link}] CRITICAL error occurred:`, error);
    try {
        await bot.telegram.sendMessage(task.chatId, ' An error occurred while processing pinned stories. The admin has been notified.');
    } catch (e) { /* ignore */}
    throw error;

  } finally {
    console.log(`[SendPinnedStories] [${task.link}] Function execution complete.`);
  }
}
