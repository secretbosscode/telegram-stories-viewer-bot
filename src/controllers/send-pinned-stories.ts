// src/controllers/send-pinned-stories.ts

import { Userbot } from 'config/userbot';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { chunkMediafiles, timeout, sendTemporaryMessage } from 'lib';
import { Markup } from 'telegraf';
import { t } from 'lib/i18n';
import { Api } from 'telegram';
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram';
import {
  SendStoriesArgs,
  StoriesModel,
  MappedStoryItem,
  NotifyAdminParams,
  DownloadStoriesResult,
} from 'types';
import { downloadStories, mapStories } from 'controllers/download-stories';
import { notifyAdmin } from 'controllers/send-message';
import { sendStoryFallbacks } from 'controllers/story-fallback';
import { PartialStoryDeliveryError } from 'controllers/send-paginated-stories';
import { ensureStealthMode } from 'services/stealth-mode';

const PINNED_CAPTION_LIMIT = 1024;

const buildPinnedCaption = (caption: string | undefined, suffix: string): string => {
  const normalizedCaption = caption?.trim();
  if (!normalizedCaption) return suffix.slice(0, PINNED_CAPTION_LIMIT);
  const separator = '\n\n';
  const fullCaption = `${normalizedCaption}${separator}${suffix}`;
  if (fullCaption.length <= PINNED_CAPTION_LIMIT) return fullCaption;
  const available = PINNED_CAPTION_LIMIT - suffix.length - separator.length;
  if (available <= 0) return suffix.slice(0, PINNED_CAPTION_LIMIT);
  return `${normalizedCaption.slice(0, available)}${separator}${suffix}`;
};

async function sendSinglePinned(story: MappedStoryItem, task: SendStoriesArgs['task']): Promise<void> {
  const caption = buildPinnedCaption(story.caption, `Pinned story from ${task.link}`);
  const media = { source: story.buffer! };
  if (story.mediaType === 'photo') {
    await bot.telegram.sendPhoto(task.chatId, media, { caption });
  } else {
    await bot.telegram.sendVideo(task.chatId, media, { caption });
  }
}

/** Returns the exact pinned-story IDs confirmed delivered by Telegram or fallback. */
export async function sendPinnedStories({ stories, task }: SendStoriesArgs): Promise<number[]> {
  const deliveredStoryIds = new Set<number>();

  try {
    let mapped: StoriesModel = stories;
    const requesterId = String(task.user?.id ?? task.chatId);
    const isAdmin = requesterId === String(BOT_ADMIN_ID);
    const paidDelivery = Boolean(task.starsBundleId);
    const isPrivileged = Boolean(task.isPremium || isAdmin || paidDelivery);
    const STORY_LIMIT_FOR_FREE_USERS = 5;
    const PER_PAGE = 5;
    let wasLimited = false;
    let hasMorePages = false;
    const nextStories: Record<string, number[]> = {};

    // Paid bundles must deliver the complete purchased set in the current job.
    if (!paidDelivery && (task.isPremium || isAdmin) && mapped.length > PER_PAGE) {
      hasMorePages = true;
      const currentStories = mapped.slice(0, PER_PAGE);
      for (let i = PER_PAGE; i < mapped.length; i += PER_PAGE) {
        const from = i + 1;
        const to = Math.min(i + PER_PAGE, mapped.length);
        nextStories[`${from}-${to}`] = mapped
          .slice(i, i + PER_PAGE)
          .map((story: MappedStoryItem) => story.id);
      }
      mapped = currentStories;
    }

    if (!isPrivileged && mapped.length > STORY_LIMIT_FOR_FREE_USERS) {
      wasLimited = true;
      mapped = mapped.slice(0, STORY_LIMIT_FOR_FREE_USERS);
    }

    const storiesWithoutMedia = mapped.filter((story: MappedStoryItem) => !story.media);
    if (storiesWithoutMedia.length > 0) {
      try {
        const client = await Userbot.getInstance();
        const entity = await client.getEntity(task.link!);
        await ensureStealthMode();
        const response = await client.invoke(
          new Api.stories.GetStoriesByID({
            id: storiesWithoutMedia.map((story: MappedStoryItem) => story.id),
            peer: entity,
          }),
        );
        const refreshed = mapStories(response.stories);
        const refreshedById = new Map(refreshed.map((story) => [story.id, story]));
        mapped = mapped.map((story) => refreshedById.get(story.id) ?? story);
      } catch (error) {
        console.error('[SendPinnedStories] Error re-fetching stories without media:', error);
      }
    }

    mapped.forEach((story) => {
      story.source = {
        ...(story.source ?? {}),
        identifier: story.source?.identifier ?? task.link,
        displayName: story.source?.displayName ?? task.link,
      };
    });

    await sendTemporaryMessage(bot, task.chatId, t(task.locale, 'pinned.downloading')).catch(
      (error) => console.error('[SendPinnedStories] Failed to send downloading message:', error),
    );

    const downloadPromise = downloadStories(mapped, 'pinned');
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Download process timed out after 5 minutes.')), 300000),
    );
    const downloadResult = await Promise.race<DownloadStoriesResult>([
      downloadPromise,
      timeoutPromise as unknown as Promise<DownloadStoriesResult>,
    ]);

    const uploadableStories = mapped.filter(
      (story: MappedStoryItem) => story.buffer && Number(story.bufferSize ?? 0) <= 50,
    );
    const fallbackCandidates = mapped.filter(
      (story: MappedStoryItem) => !story.buffer || Number(story.bufferSize ?? 0) > 50,
    );

    if (uploadableStories.length > 0) {
      await sendTemporaryMessage(
        bot,
        task.chatId,
        t(task.locale, 'pinned.uploading', { count: uploadableStories.length }),
      ).catch((error) => console.error('[SendPinnedStories] Failed to send uploading message:', error));

      if (uploadableStories.length === 1) {
        await sendSinglePinned(uploadableStories[0], task);
        deliveredStoryIds.add(uploadableStories[0].id);
      } else {
        for (const album of chunkMediafiles(uploadableStories)) {
          if (album.length === 1) {
            await sendSinglePinned(album[0], task);
            deliveredStoryIds.add(album[0].id);
          } else {
            await bot.telegram.sendMediaGroup(
              task.chatId,
              album.map((story: MappedStoryItem) => ({
                media: { source: story.buffer! },
                type: story.mediaType!,
                caption: buildPinnedCaption(story.caption, `Pinned story from ${task.link}`),
              })),
            );
            album.forEach((story: MappedStoryItem) => deliveredStoryIds.add(story.id));
          }
          await timeout(500);
        }
      }

      if (hasMorePages) {
        const buttons = Object.entries(nextStories).map(([pages, ids]) => ({
          text: `📥 ${pages} 📥`,
          callback_data: `${task.link}&${JSON.stringify(ids)}`,
        }));
        const keyboard = buttons.reduce(
          (rows: InlineKeyboardButton[][], button: InlineKeyboardButton, index: number) => {
            const row = Math.floor(index / 3);
            if (!rows[row]) rows[row] = [];
            rows[row].push(button);
            return rows;
          },
          [],
        );
        await bot.telegram.sendMessage(
          task.chatId,
          t(task.locale, 'pinned.selectNext'),
          Markup.inlineKeyboard(keyboard),
        );
      }
    }

    if (fallbackCandidates.length > 0) {
      const fallbackIds = await sendStoryFallbacks(task, fallbackCandidates);
      fallbackIds.forEach((storyId) => deliveredStoryIds.add(storyId));
    }

    if (deliveredStoryIds.size === 0) {
      await bot.telegram.sendMessage(task.chatId, t(task.locale, 'pinned.none'));
    }

    if (wasLimited) {
      await timeout(1000);
      await bot.telegram.sendMessage(
        task.chatId,
        t(task.locale, 'pinned.limitReached', { limit: STORY_LIMIT_FOR_FREE_USERS }),
        { parse_mode: 'Markdown' },
      );
    }

    notifyAdmin({
      task,
      status: 'info',
      baseInfo: `📥 ${deliveredStoryIds.size} Pinned stories delivered for ${task.link} (chatId: ${task.chatId})!`,
    } as NotifyAdminParams);

    // Preserve compatibility with download implementations that report failures
    // but still populated buffers: the delivered set remains the source of truth.
    void downloadResult;
    return [...deliveredStoryIds];
  } catch (error) {
    console.error(`[SendPinnedStories] [${task.link}] CRITICAL error occurred:`, error);
    await bot.telegram.sendMessage(task.chatId, t(task.locale, 'pinned.error')).catch(() => {});
    const partialIds = [...deliveredStoryIds];
    if (partialIds.length > 0) {
      throw new PartialStoryDeliveryError(error, partialIds);
    }
    throw error;
  }
}
