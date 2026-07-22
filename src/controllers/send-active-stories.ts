// src/controllers/send-active-stories.ts

import { Userbot } from 'config/userbot';
import { bot } from 'index';
import { chunkMediafiles, sendTemporaryMessage } from 'lib';
import { Markup } from 'telegraf';
import { Api } from 'telegram';
import { t } from 'lib/i18n';
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram';
import { SendStoriesArgs, MappedStoryItem, StoriesModel, NotifyAdminParams } from 'types';
import { downloadStories, mapStories } from 'controllers/download-stories';
import { notifyAdmin } from 'controllers/send-message';
import { sendStoryFallbacks } from 'controllers/story-fallback';
import { ensureStealthMode } from 'services/stealth-mode';

/**
 * Sends active stories and returns the exact story IDs that were delivered as
 * Telegram media or as valid exported fallback links.
 */
export async function sendActiveStories({
  stories,
  task,
}: SendStoriesArgs): Promise<number[]> {
  let mapped: StoriesModel = stories;
  const deliveredStoryIds = new Set<number>();

  let hasMorePages = false;
  const nextStories: Record<string, number[]> = {};
  const PER_PAGE = 5;

  if (stories.length > PER_PAGE) {
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

  const storiesWithoutMedia: MappedStoryItem[] = mapped.filter(
    (x: MappedStoryItem) => !x.media,
  );
  if (storiesWithoutMedia.length > 0) {
    mapped = mapped.filter((x: MappedStoryItem) => Boolean(x.media));
    try {
      const client = await Userbot.getInstance();
      const entity = await client.getEntity(task.link!);
      const ids = storiesWithoutMedia.map((x: MappedStoryItem) => x.id);
      await ensureStealthMode();
      const storiesWithMediaApi = await client.invoke(
        new Api.stories.GetStoriesByID({ id: ids, peer: entity }),
      );
      mapped.push(...mapStories(storiesWithMediaApi.stories));
    } catch (error) {
      console.error('[sendActiveStories] Error re-fetching stories without media:', error);
    }
  }

  mapped.forEach((story) => {
    story.source = {
      ...(story.source ?? {}),
      identifier: story.source?.identifier ?? task.link,
      displayName: story.source?.displayName ?? task.link,
    };
  });

  try {
    await sendTemporaryMessage(
      bot,
      task.chatId,
      t(task.locale, 'active.downloading', { user: task.link }),
    ).catch((error) => {
      console.error(
        `[sendActiveStories] Failed to send 'Downloading Active stories' message to ${task.chatId}:`,
        error,
      );
    });

    const downloadResult = await downloadStories(mapped, 'active');

    const uploadableStories: MappedStoryItem[] = mapped.filter(
      (story: MappedStoryItem) => story.buffer && story.bufferSize! <= 47,
    );
    const oversizeStories = mapped.filter(
      (story: MappedStoryItem) => story.buffer && story.bufferSize! > 47,
    );
    const failedDownloads = downloadResult.failed.filter((story) => !story.buffer);
    const fallbackCandidates = [
      ...failedDownloads,
      ...oversizeStories.filter(
        (story) => !failedDownloads.some((failed) => failed.id === story.id),
      ),
    ];

    if (uploadableStories.length > 0) {
      await sendTemporaryMessage(
        bot,
        task.chatId,
        t(task.locale, 'active.uploading', {
          count: uploadableStories.length,
          user: task.link,
        }),
      ).catch((error) => {
        console.error(
          `[sendActiveStories] Failed to send 'Uploading' message to ${task.chatId}:`,
          error,
        );
      });

      if (uploadableStories.length === 1) {
        const single = uploadableStories[0];
        const captionText = `${single.caption ? single.caption + '\n\n' : ''}Active story from ${task.link}`;
        const media = { source: single.buffer! };
        const extra = { caption: captionText.slice(0, 1024) };
        if (single.mediaType === 'photo') {
          await bot.telegram.sendPhoto(task.chatId, media, extra);
        } else {
          await bot.telegram.sendVideo(task.chatId, media, extra);
        }
        deliveredStoryIds.add(single.id);
      } else {
        const chunkedList = chunkMediafiles(uploadableStories);
        for (const album of chunkedList) {
          await bot.telegram.sendMediaGroup(
            task.chatId,
            album.map((story: MappedStoryItem) => {
              const captionText = `${story.caption ? `${story.caption}\n\n` : ''}Active story from ${task.link}`;
              return {
                media: { source: story.buffer! },
                type: story.mediaType,
                caption: captionText.slice(0, 1024),
              };
            }),
          );
          album.forEach((story: MappedStoryItem) => deliveredStoryIds.add(story.id));
        }
      }
    }

    if (fallbackCandidates.length > 0) {
      const fallbackIds = await sendStoryFallbacks(task, fallbackCandidates);
      fallbackIds.forEach((storyId) => deliveredStoryIds.add(storyId));
    }

    if (deliveredStoryIds.size === 0) {
      await bot.telegram.sendMessage(task.chatId, t(task.locale, 'active.none'));
    }

    if (hasMorePages) {
      const btns = Object.entries(nextStories).map(
        ([pages, nextStoriesIds]: [string, number[]]) => ({
          text: `📥 ${pages} 📥`,
          callback_data: `${task.link}&${JSON.stringify(nextStoriesIds)}`,
        }),
      );
      const keyboard = btns.reduce(
        (acc: InlineKeyboardButton[][], curr: InlineKeyboardButton, index: number) => {
          const chunkIndex = Math.floor(index / 3);
          if (!acc[chunkIndex]) acc[chunkIndex] = [];
          acc[chunkIndex].push(curr);
          return acc;
        },
        [],
      );
      await sendTemporaryMessage(
        bot,
        task.chatId,
        t(task.locale, 'active.uploadedBatch', {
          sent: PER_PAGE,
          total: stories.length,
          user: task.link,
        }),
        Markup.inlineKeyboard(keyboard),
      );
    }

    notifyAdmin({
      task,
      status: 'info',
      baseInfo: `📥 ${deliveredStoryIds.size} Active stories delivered to user!`,
    } as NotifyAdminParams);

    return [...deliveredStoryIds];
  } catch (error: any) {
    notifyAdmin({
      task,
      status: 'error',
      errorInfo: { cause: error },
    } as NotifyAdminParams);
    console.error('[sendActiveStories] Error sending ACTIVE stories:', error);
    try {
      await bot.telegram
        .sendMessage(task.chatId, t(task.locale, 'active.error'))
        .catch((notifyError) => {
          console.error(
            `[sendActiveStories] Failed to notify ${task.chatId} about general error:`,
            notifyError,
          );
        });
    } catch (_) {
      // Ignore notification failures; the original delivery error is rethrown.
    }
    throw error;
  }
}
