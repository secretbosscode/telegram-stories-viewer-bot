// src/controllers/send-active-stories.ts

import { Userbot } from 'config/userbot';
import { bot } from 'index';
import { sendTemporaryMessage } from 'lib';
import { uploadStoryMedia } from 'controllers/upload-story-media';
import { Markup } from 'telegraf';
import { Api } from 'telegram';
import { t } from 'lib/i18n';
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram';
import { SendStoriesArgs, MappedStoryItem, StoriesModel, NotifyAdminParams } from 'types';
import { downloadStories, mapStories } from 'controllers/download-stories';
import { notifyAdmin } from 'controllers/send-message';
import { sendStoryFallbacks } from 'controllers/story-fallback';
import { PartialStoryDeliveryError } from 'controllers/send-paginated-stories';
import { ensureStealthMode } from 'services/stealth-mode';

/**
 * Sends active stories and returns the exact story IDs delivered as Telegram
 * media or valid exported fallback links.
 *
 * Paid Stars bundles and monitoring alerts always deliver the complete input
 * set in one job. Ordinary interactive requests retain the five-item paging UI.
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
  const deliverAll = Boolean(task.starsBundleId || (task as any).monitorDelivery);

  if (!deliverAll && stories.length > PER_PAGE) {
    hasMorePages = true;
    const currentStories: MappedStoryItem[] = mapped.slice(0, PER_PAGE);
    for (let i = PER_PAGE; i < mapped.length; i += PER_PAGE) {
      const from = i + 1;
      const to = Math.min(i + PER_PAGE, mapped.length);
      nextStories[`${from}-${to}`] = mapped
        .slice(i, i + PER_PAGE)
        .map((story: MappedStoryItem) => story.id);
    }
    mapped = currentStories;
  }

  const storiesWithoutMedia = mapped.filter((story: MappedStoryItem) => !story.media);
  if (storiesWithoutMedia.length > 0) {
    mapped = mapped.filter((story: MappedStoryItem) => Boolean(story.media));
    try {
      const client = await Userbot.getInstance();
      const entity = await client.getEntity(task.link!);
      const ids = storiesWithoutMedia.map((story: MappedStoryItem) => story.id);
      await ensureStealthMode();
      const response = await client.invoke(
        new Api.stories.GetStoriesByID({ id: ids, peer: entity }),
      );
      mapped.push(...mapStories(response.stories));
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
        `[sendActiveStories] Failed to send downloading message to ${task.chatId}:`,
        error,
      );
    });

    const downloadResult = await downloadStories(mapped, 'active');
    const uploadableStories = mapped.filter((story) => story.buffer);
    const fallbackCandidates = downloadResult.failed.filter((story) => !story.buffer);

    if (uploadableStories.length > 0) {
      await sendTemporaryMessage(
        bot,
        task.chatId,
        t(task.locale, 'active.uploading', {
          count: uploadableStories.length,
          user: task.link,
        }),
      ).catch((error) => {
        console.error(`[sendActiveStories] Failed to send uploading message to ${task.chatId}:`, error);
      });

      const tooLarge = await uploadStoryMedia(
        task.chatId, uploadableStories,
        (story) => `${story.caption ? `${story.caption}\n\n` : ''}Active story from ${task.link}`,
        deliveredStoryIds,
      );
      fallbackCandidates.push(...tooLarge);
    }

    if (fallbackCandidates.length > 0) {
      const fallbackIds = await sendStoryFallbacks(task, fallbackCandidates);
      fallbackIds.forEach((storyId) => deliveredStoryIds.add(storyId));
    }

    if (deliveredStoryIds.size === 0) {
      await bot.telegram.sendMessage(task.chatId, t(task.locale, 'active.none'));
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
      // The paging keyboard must persist: it is the only way to reach the
      // remaining stories, and a temporary message would delete itself after
      // 30 seconds (and race the callback handler's own delete).
      await bot.telegram.sendMessage(
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
  } catch (error) {
    notifyAdmin({
      task,
      status: 'error',
      errorInfo: { cause: error },
    } as NotifyAdminParams);
    console.error('[sendActiveStories] Error sending ACTIVE stories:', error);
    await bot.telegram.sendMessage(task.chatId, t(task.locale, 'active.error')).catch(() => {});

    const partialIds = [...deliveredStoryIds];
    if ((task as any).monitorDelivery && partialIds.length > 0) {
      console.warn(`[sendActiveStories] Partial monitor delivery for ${task.link}; remaining stories will retry.`);
      return partialIds;
    }
    if (partialIds.length > 0) {
      throw new PartialStoryDeliveryError(error, partialIds);
    }
    throw error;
  }
}
