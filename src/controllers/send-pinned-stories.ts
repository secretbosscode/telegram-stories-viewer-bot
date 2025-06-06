import { Userbot } from 'config/userbot';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { chunkMediafiles, timeout } from 'lib';
import { Markup } from 'telegraf';
import { Api } from 'telegram';
// REMOVED: import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram'; // Not directly used in this snippet

// CORRECTED: Import types from your central types.ts file
import { UserInfo, SendStoriesArgs, StoriesModel, NotifyAdminParams } from 'types'; // <--- Corrected import path & Added NotifyAdminParams

// Corrected import path for downloadStories and mapStories
import { downloadStories, mapStories } from 'controllers/download-stories'; // <--- Corrected import path
import { notifyAdmin } from 'controllers/send-message'; // <--- Corrected import path

// =========================================================================
// CRITICAL FUNCTION: This function handles downloading and sending stories.
// It contains essential error handling and business logic for premium users.
// =========================================================================
export async function sendPinnedStories({ stories, task }: SendStoriesArgs): Promise<void> {
  try {
    // mapped is already MappedStoryItem[] because SendStoriesArgs.stories is MappedStoryItem[]
    // However, if the `stories` parameter coming into this function might be Api.TypeStoryItem[],
    // then mapStories is still needed here. Assuming it receives MappedStoryItem[].
    // If it receives Api.TypeStoryItem[], you would need `let mapped: StoriesModel = mapStories(stories as Api.TypeStoryItem[]);`
    let mapped: StoriesModel = stories; // Assuming stories is already MappedStoryItem[] from SendStoriesArgs

    // =========================================================================
    // CORE BUSINESS LOGIC: User Limits and Premium Upsell
    // This block enforces the story limit for non-privileged users.
    // =========================================================================
    const isPrivileged = task.isPremium || task.chatId === BOT_ADMIN_ID.toString();
    const STORY_LIMIT_FOR_FREE_USERS = 5;
    let wasLimited = false;

    if (!isPrivileged && mapped.length > STORY_LIMIT_FOR_FREE_USERS) {
      console.log(`[SendPinnedStories] Limiting non-premium user ${task.chatId} to ${STORY_LIMIT_FOR_FREE_USERS} stories.`);
      wasLimited = true;
      mapped = mapped.slice(0, STORY_LIMIT_FOR_FREE_USERS);
    }

    // Re-fetching stories that might have been mapped without media objects.
    // This logic relies on Api.stories.GetStoriesByID. The `storiesWithoutMedia` are MappedStoryItem[].
    // You'd need to convert them back to IDs and pass to Telegram API.
    const storiesWithoutMedia = mapped.filter((x) => !x.media);
    if (storiesWithoutMedia.length > 0) {
      try {
        const client = await Userbot.getInstance();
        const entity = await client.getEntity(task.link!); // task.link used as entity identifier
        const ids = storiesWithoutMedia.map((x) => x.id); // Assuming MappedStoryItem.id is Telegram story ID (number)
        const storiesWithMediaApi = await client.invoke(
          new Api.stories.GetStoriesByID({ id: ids, peer: entity })
        );
        // Map fetched raw API stories back to MappedStoryItem and push to `mapped`
        const newMappedStories = mapStories(storiesWithMediaApi.stories);
        mapped.push(...newMappedStories);
      } catch (e) {
        console.error(`[SendPinnedStories] Error re-fetching stories without media: ${e}`);
        // Fallback: just continue with those that have media
      }
    }

    console.log(`[SendPinnedStories] [${task.link}] Preparing to download ${mapped.length} pinned stories.`);

    await bot.telegram.sendMessage(
      task.chatId!,
      '⏳ Downloading Pinned stories...'
    ).catch(() => null);

    // =========================================================================
    // CRITICAL STABILITY LOGIC: Download Timeout
    // This prevents the bot from getting stuck indefinitely on a hanging download.
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
      ).catch(() => null);

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
    } as NotifyAdminParams); // <--- Added type assertion for notifyAdmin params
    console.log(`[SendPinnedStories] [${task.link}] Processing finished successfully.`);

  } catch (error) {
    // =========================================================================
    // CRITICAL ERROR HANDLING - DO NOT REMOVE `throw error`
    // This catch block ensures any failure in this function is propagated up to
    // `sendStoriesFx`. This rejection is essential for Effector's `.fail` event
    // to trigger, which un-sticks the queue and allows the bot to continue.
    // =========================================================================
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    } as NotifyAdminParams); // <--- Added type assertion for notifyAdmin params
    console.error(`[SendPinnedStories] [${task.link}] CRITICAL error occurred:`, error);
    try {
        await bot.telegram.sendMessage(task.chatId, ' An error occurred while processing pinned stories. The admin has been notified.');
    } catch (e) { /* ignore */}
    throw error; // Essential for Effector's .fail to trigger

  } finally {
    console.log(`[SendPinnedStories] [${task.link}] Function execution complete.`);
  }
}
