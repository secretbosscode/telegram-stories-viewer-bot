// src/controllers/send-active-stories.ts

import { Userbot } from 'config/userbot';
import { bot } from 'index'; // Corrected path to use tsconfig alias
import { chunkMediafiles, sendTemporaryMessage } from 'lib';
import { Markup } from 'telegraf';
import { Api } from 'telegram';
import { t } from "lib/i18n";

// CORRECTED: Import InlineKeyboardButton for precise typing
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram'; // <--- This import is key for fixing TS2724

// CORRECTED: Import types from your central types.ts file
import { SendStoriesArgs, MappedStoryItem, StoriesModel, NotifyAdminParams } from 'types';

// Corrected import path for downloadStories and mapStories
import { downloadStories, mapStories } from 'controllers/download-stories';
import { notifyAdmin } from 'controllers/send-message';

/**
 * Sends a user's active stories as Telegram media groups.
 * Handles pagination, download, error reporting, and premium up-sell.
 */
export async function sendActiveStories({ stories, task }: SendStoriesArgs) {
  // `stories` here is expected to be `MappedStoryItem[]` from SendStoriesArgs
  let mapped: StoriesModel = stories; // Explicitly typed mapped to StoriesModel (MappedStoryItem[])

  // === Pagination logic for >5 stories (per page) ===
  let hasMorePages = false;
  const nextStories: Record<string, number[]> = {};
  const PER_PAGE = 5;

  if (stories.length > PER_PAGE) {
    hasMorePages = true;
    const currentStories: MappedStoryItem[] = mapped.slice(0, PER_PAGE); // Explicitly typed
    for (let i = PER_PAGE; i < mapped.length; i += PER_PAGE) {
      const from = i + 1;
      const to = Math.min(i + PER_PAGE, mapped.length);
      // CORRECTED LINE: Removed LaTeX delimiters and used template literal correctly
      nextStories[`${from}-${to}`] = mapped.slice(i, i + PER_PAGE).map((x: MappedStoryItem) => x.id); // <--- 'x' is typed here
    }
    mapped = currentStories;
  }

  // === If any stories missing media, refetch via Userbot ===
  const storiesWithoutMedia: MappedStoryItem[] = mapped.filter((x: MappedStoryItem) => !x.media); // <--- 'x' is typed here
  if (storiesWithoutMedia.length > 0) {
    mapped = mapped.filter((x: MappedStoryItem) => Boolean(x.media)); // <--- 'x' is typed here
    try {
      const client = await Userbot.getInstance();
      const entity = await client.getEntity(task.link!);
      const ids = storiesWithoutMedia.map((x: MappedStoryItem) => x.id); // <--- 'x' is typed here
      const storiesWithMediaApi = await client.invoke(
        new Api.stories.GetStoriesByID({ id: ids, peer: entity })
      );
      mapped.push(...mapStories(storiesWithMediaApi.stories));
    } catch (e) {
      console.error('[sendActiveStories] Error re-fetching stories without media:', e);
      // Fallback: just continue with those that have media
    }
  }

  try {
    // --- User notification: downloading ---
    await sendTemporaryMessage(
      bot,
      task.chatId,
      t(task.locale, 'active.downloading', { user: task.link })
    ).catch((err) => {
      console.error(
        `[sendActiveStories] Failed to send 'Downloading Active stories' message to ${task.chatId}:`,
        err
      );
    });

    // --- Download stories to buffer ---
    await downloadStories(mapped, 'active');

    // --- Only upload files with buffer and size <= 47MB (Telegram API limit fudge) ---
    const uploadableStories: MappedStoryItem[] = mapped.filter(
      (x: MappedStoryItem) => x.buffer && x.bufferSize! <= 47 // <--- 'x' is typed here
    );

    // --- Notify user about upload ---
    if (uploadableStories.length > 0) {
      await sendTemporaryMessage(
        bot,
        task.chatId,
        t(task.locale, 'active.uploading', { count: uploadableStories.length, user: task.link })
      ).catch((err) => {
        console.error(
          `[sendActiveStories] Failed to send 'Uploading' message to ${task.chatId}:`,
          err
        );
      });
      if (uploadableStories.length === 1) {
        await sendTemporaryMessage(bot, task.chatId, `Active story from ${task.link}`).catch(
          (err) => {
            console.error(
              `[sendActiveStories] Failed to send 'Active story from' message to ${task.chatId}:`,
              err
            );
          }
        );

        const single = uploadableStories[0];
        const media: any = { media: { source: single.buffer! }, type: single.mediaType };
        if (single.caption) {
          media.caption = single.caption.slice(0, 1024);
        }
        await bot.telegram.sendMediaGroup(task.chatId, [media]);
      } else {
        // --- Send in chunks (albums) ---
        const chunkedList = chunkMediafiles(uploadableStories);
        for (const album of chunkedList) {
          await bot.telegram.sendMediaGroup(
            task.chatId,
            album.map((x: MappedStoryItem) => {
              const captionText = `${x.caption ? `${x.caption}\n\n` : ''}Active story from ${task.link}`;
              return {
                media: { source: x.buffer! },
                type: x.mediaType,
                caption: captionText.slice(0, 1024),
              };
            })
          );
        }
      }
    } else {
      await bot.telegram.sendMessage(
        task.chatId,
        t(task.locale, 'active.none')
      );
    }

    // --- If more pages, offer buttons for the rest ---
    if (hasMorePages) {
      const btns = Object.entries(nextStories).map(
        ([pages, nextStoriesIds]: [string, number[]]) => ({
          text: `📥 ${pages} 📥`,
          // CORRECTED LINE: Removed LaTeX delimiters and used template literal correctly
          callback_data: `${task.link}&${JSON.stringify(nextStoriesIds)}`,
        })
      );
      // Chunk 3 buttons per row
      // CORRECTED: Explicitly typed 'acc' and 'curr' in reduce
      const keyboard = btns.reduce((acc: InlineKeyboardButton[][], curr: InlineKeyboardButton, index: number) => { // <--- Types fixed here
        const chunkIndex = Math.floor(index / 3);
        if (!acc[chunkIndex]) acc[chunkIndex] = [];
        acc[chunkIndex].push(curr);
        return acc;
      }, []);
      await sendTemporaryMessage(
        bot,
        task.chatId,
        t(task.locale, 'active.uploadedBatch', { sent: PER_PAGE, total: stories.length, user: task.link }),
        Markup.inlineKeyboard(keyboard)
      );
    }

    notifyAdmin({
      task,
      status: 'info',
      baseInfo: `📥 ${uploadableStories.length} Active stories uploaded to user!`,
    } as NotifyAdminParams);

  } catch (error: any) {
    notifyAdmin({
      task,
      status: 'error',
      errorInfo: { cause: error },
    } as NotifyAdminParams);
    console.error('[sendActiveStories] Error sending ACTIVE stories:', error);
    try {
      await bot.telegram
        .sendMessage(
          task.chatId,
          t(task.locale, 'active.error')
        )
        .catch((err) => {
          console.error(
            `[sendActiveStories] Failed to notify ${task.chatId} about general error:`,
            err
          );
        });
    } catch (_) {/* ignore */}
    throw error;
  }
}
