// src/controllers/send-pinned-stories.ts

import { Userbot } from 'config/userbot';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { chunkMediafiles, timeout, sendTemporaryMessage } from 'lib';
import { Markup } from 'telegraf';
import { Api } from 'telegram';

// CORRECTED: Import InlineKeyboardButton for precise typing (if Markup.inlineKeyboard uses it explicitly in its return type)
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram'; // <--- ADDED: For InlineKeyboardButton

// CORRECTED: Import types from your central types.ts file
import { UserInfo, SendStoriesArgs, StoriesModel, MappedStoryItem, NotifyAdminParams } from 'types'; // <--- Added MappedStoryItem for explicit typing

// Corrected import path for downloadStories and mapStories
import { downloadStories, mapStories } from 'controllers/download-stories';
import { notifyAdmin } from 'controllers/send-message';

// =========================================================================
// CRITICAL FUNCTION: This function handles downloading and sending stories.
// It contains essential error handling and business logic for premium users.
// =========================================================================
export async function sendPinnedStories({ stories, task }: SendStoriesArgs): Promise<void> {
  try {
    // `stories` here is expected to be `MappedStoryItem[]` from SendStoriesArgs
    let mapped: StoriesModel = stories; // Explicitly typed mapped to StoriesModel (MappedStoryItem[])

    const isAdmin = task.chatId === BOT_ADMIN_ID.toString();

    // =========================================================================
    // CORE BUSINESS LOGIC: User Limits and Premium Upsell
    // This block enforces the story limit for non-privileged users.
    // =========================================================================
    const isPrivileged = task.isPremium || isAdmin;
    const STORY_LIMIT_FOR_FREE_USERS = 5;
    let wasLimited = false;

    // Pagination setup for premium users (non-admin) if too many stories
    const PER_PAGE = 5;
    let hasMorePages = false;
    const nextStories: Record<string, number[]> = {};

    if (task.isPremium && !isAdmin && mapped.length > PER_PAGE) {
      hasMorePages = true;
      const currentStories: MappedStoryItem[] = mapped.slice(0, PER_PAGE);
      for (let i = PER_PAGE; i < mapped.length; i += PER_PAGE) {
        const from = i + 1;
        const to = Math.min(i + PER_PAGE, mapped.length);
        nextStories[`${from}-${to}`] = mapped
          .slice(i, i + PER_PAGE)
          .map((x: MappedStoryItem) => x.id);
      }
      mapped = currentStories;
    }

    if (!isPrivileged && mapped.length > STORY_LIMIT_FOR_FREE_USERS) {
      console.log(`[SendPinnedStories] Limiting non-premium user ${task.chatId} to ${STORY_LIMIT_FOR_FREE_USERS} stories.`);
      wasLimited = true;
      mapped = mapped.slice(0, STORY_LIMIT_FOR_FREE_USERS);
    }

    // Re-fetching stories that might have been mapped without media objects.
    const storiesWithoutMedia: MappedStoryItem[] = mapped.filter((x: MappedStoryItem) => !x.media); // <--- 'x' typed
    if (storiesWithoutMedia.length > 0) {
      // Your existing logic for re-fetching stories by ID
      // This block has its own try/catch and is self-contained.
      try { // Added try/catch for this section if not already present
        const client = await Userbot.getInstance();
        const entity = await client.getEntity(task.link!);
        const ids = storiesWithoutMedia.map((x: MappedStoryItem) => x.id); // <--- 'x' typed
        const storiesWithMediaApi = await client.invoke(
          new Api.stories.GetStoriesByID({ id: ids, peer: entity })
        );
        const newMappedStories = mapStories(storiesWithMediaApi.stories);
        mapped.push(...newMappedStories);
      } catch (e) {
        console.error(`[SendPinnedStories] Error re-fetching stories without media: ${e}`);
        // Fallback: just continue with those that have media
      }
    }

    console.log(`[SendPinnedStories] [${task.link}] Preparing to download ${mapped.length} pinned stories.`);

    await sendTemporaryMessage(
      bot,
      task.chatId!,
      '⏳ Downloading Pinned stories...'
    ).catch((err) => {
      console.error(
        `[SendPinnedStories] Failed to send 'Downloading Pinned stories' message to ${task.chatId}:`,
        err
      );
    });

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

    const uploadableStories: MappedStoryItem[] = mapped.filter( // <--- 'x' typed
      (x: MappedStoryItem) => x.buffer && x.bufferSize! <= 50
    );

    console.log(`[SendPinnedStories] [${task.link}] Found ${uploadableStories.length} uploadable pinned stories after download.`);

    if (uploadableStories.length > 0) {
      await sendTemporaryMessage(
        bot,
        task.chatId!,
        `📥 ${uploadableStories.length} Pinned stories downloaded successfully!\n⏳ Uploading stories to Telegram...`
      ).catch((err) => {
        console.error(
          `[SendPinnedStories] Failed to send 'Uploading' message to ${task.chatId}:`,
          err
        );
      });

      const chunkedList = chunkMediafiles(uploadableStories);
      for (let i = 0; i < chunkedList.length; i++) {
        const album = chunkedList[i];
        const isSingle = album.length === 1;
        try {
          await bot.telegram.sendMediaGroup(
            task.chatId,
            album.map((x: MappedStoryItem) => ({
              media: { source: x.buffer! },
              type: x.mediaType!,
              caption: isSingle ? undefined : x.caption ?? `Pinned story ${x.id}`,
            }))
          );
        } catch (sendError) {
          console.error(
            `[SendPinnedStories] [${task.link}] Error sending media group chunk ${i + 1}:`,
            sendError,
          );
          throw sendError;
        }
        if (isSingle) {
          const story = album[0];
          await sendTemporaryMessage(
            bot,
            task.chatId!,
            story.caption ?? `Pinned story ${story.id}`,
          ).catch((err) => {
            console.error(
              `[SendPinnedStories] Failed to send temporary caption to ${task.chatId}:`,
              err,
            );
          });
        }
        await timeout(500);
      }

      if (hasMorePages) {
        const btns = Object.entries(nextStories).map(
          ([pages, nextStoriesIds]: [string, number[]]) => ({
            text: `📥 ${pages} 📥`,
            callback_data: `${task.link}&${JSON.stringify(nextStoriesIds)}`,
          })
        );
        const keyboard = btns.reduce(
          (
            acc: InlineKeyboardButton[][],
            curr: InlineKeyboardButton,
            index: number
          ) => {
            const chunkIndex = Math.floor(index / 3);
            if (!acc[chunkIndex]) acc[chunkIndex] = [];
            acc[chunkIndex].push(curr);
            return acc;
          },
          [] as InlineKeyboardButton[][]
        );
        await sendTemporaryMessage(
          bot,
          task.chatId!,
          `Uploaded ${PER_PAGE}/${stories.length} pinned stories ✅`,
          Markup.inlineKeyboard(keyboard),
        );
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
    } as NotifyAdminParams);
    console.log(`[SendPinnedStories] [${task.link}] Processing finished successfully.`);

  } catch (error: any) { // <--- Explicitly typed error as any
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    } as NotifyAdminParams);
    console.error(`[SendPinnedStories] [${task.link}] CRITICAL error occurred:`, error);
    try {
        await bot.telegram.sendMessage(task.chatId, ' An error occurred while processing pinned stories. The admin has been notified.');
    } catch (e) { /* ignore */}
    throw error;
  } finally {
    console.log(`[SendPinnedStories] [${task.link}] Function execution complete.`);
  }
}
