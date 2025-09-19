// src/controllers/send-pinned-stories.ts

import { Userbot } from 'config/userbot';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { chunkMediafiles, timeout, sendTemporaryMessage } from 'lib';
import { Markup } from 'telegraf';
import { t } from "lib/i18n";
import { Api } from 'telegram';

// CORRECTED: Import InlineKeyboardButton for precise typing (if Markup.inlineKeyboard uses it explicitly in its return type)
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram'; // <--- ADDED: For InlineKeyboardButton

// CORRECTED: Import types from your central types.ts file
import { SendStoriesArgs, StoriesModel, MappedStoryItem, NotifyAdminParams, DownloadStoriesResult } from 'types';

// Corrected import path for downloadStories and mapStories
import { downloadStories, mapStories } from 'controllers/download-stories';
import { notifyAdmin } from 'controllers/send-message';
import { sendStoryFallbacks } from 'controllers/story-fallback';
import { ensureStealthMode } from 'services/stealth-mode';

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

    // Pagination setup for premium users (and admin) if too many stories
    const PER_PAGE = 5;
    let hasMorePages = false;
    const nextStories: Record<string, number[]> = {};

    if ((task.isPremium || isAdmin) && mapped.length > PER_PAGE) {
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
        await ensureStealthMode();
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

    mapped.forEach((story) => {
      story.source = {
        ...(story.source ?? {}),
        identifier: story.source?.identifier ?? task.link,
        displayName: story.source?.displayName ?? task.link,
      };
    });

    console.log(`[SendPinnedStories] [${task.link}] Preparing to download ${mapped.length} pinned stories.`);

    await sendTemporaryMessage(
      bot,
      task.chatId!,
      t(task.locale, 'pinned.downloading')
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
    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Download process timed out after 5 minutes.')), 300000)
    );
    const downloadResult = await Promise.race<DownloadStoriesResult>([
      downloadPromise,
      timeoutPromise as unknown as Promise<DownloadStoriesResult>,
    ]);

    console.log(`[SendPinnedStories] [${task.link}] downloadStories function completed.`);

    const uploadableStories: MappedStoryItem[] = mapped.filter( // <--- 'x' typed
      (x: MappedStoryItem) => x.buffer && x.bufferSize! <= 50
    );

    console.log(`[SendPinnedStories] [${task.link}] Found ${uploadableStories.length} uploadable pinned stories after download.`);

    const failedDownloads = downloadResult.failed.filter((story) => !story.buffer);

    if (uploadableStories.length > 0) {
      await sendTemporaryMessage(
        bot,
        task.chatId!,
        t(task.locale, 'pinned.uploading', { count: uploadableStories.length })
      ).catch((err) => {
        console.error(
          `[SendPinnedStories] Failed to send 'Uploading' message to ${task.chatId}:`,
          err
        );
      });

      const chunkedList = chunkMediafiles(uploadableStories);
      for (let i = 0; i < chunkedList.length; i++) {
        const album = chunkedList[i];
        try {
          await bot.telegram.sendMediaGroup(
            task.chatId,
            album.map((x: MappedStoryItem) => ({
              media: { source: x.buffer! },
              type: x.mediaType!,
              caption: `${x.caption ?? ''}` + '\n\n' + `Pinned story from ${task.link}`,
            }))
          );
        } catch (sendError) {
          console.error(
            `[SendPinnedStories] [${task.link}] Error sending media group chunk ${i + 1}:`,
            sendError,
          );
          throw sendError;
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
        await bot.telegram.sendMessage(
          task.chatId!,
          t(task.locale, 'pinned.selectNext'),
          Markup.inlineKeyboard(keyboard),
        );
      }
    } else {
      await bot.telegram.sendMessage(
        task.chatId,
        t(task.locale, 'pinned.none')
      );
    }

    if (failedDownloads.length > 0) {
      await sendStoryFallbacks(task, failedDownloads);
    }

    // This block sends the premium upsell message if the user was limited.
    if (wasLimited) {
        await timeout(1000);
        await bot.telegram.sendMessage(
            task.chatId,
            t(task.locale, 'pinned.limitReached', { limit: STORY_LIMIT_FOR_FREE_USERS }),
            { parse_mode: 'Markdown' }
        );
    }

    notifyAdmin({
      task,
      status: 'info',
      baseInfo: `📥 ${uploadableStories.length} Pinned stories uploaded for user ${task.link} (chatId: ${task.chatId})!`,
    } as NotifyAdminParams);
    console.log(`[SendPinnedStories] [${task.link}] Processing finished successfully.`);

  } catch (error: any) { // <--- Explicitly typed error as any
    console.error(`[SendPinnedStories] [${task.link}] CRITICAL error occurred:`, error);
    try {
        await bot.telegram.sendMessage(task.chatId, t(task.locale, 'pinned.error'));
    } catch (e) { /* ignore */}
    throw error;
  }
}
