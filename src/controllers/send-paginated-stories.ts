// src/controllers/send-paginated-stories.ts

import { bot } from 'index';
import { sendTemporaryMessage } from 'lib';
import { t } from 'lib/i18n';
import { SendPaginatedStoriesArgs, MappedStoryItem, NotifyAdminParams } from 'types';
import { downloadStories, mapStories } from 'controllers/download-stories';
import { notifyAdmin } from 'controllers/send-message';
import { sendStoryFallbacks } from 'controllers/story-fallback';

const TELEGRAM_MEDIA_GROUP_LIMIT = 10;

function getStoryCaption(story: MappedStoryItem, task: SendPaginatedStoriesArgs['task']): string {
  return story.caption ?? (task.starsUnlocked
    ? `Story from ${task.link}`
    : `Pinned story ${story.id}`);
}

async function sendSingleStory(story: MappedStoryItem, task: SendPaginatedStoriesArgs['task']): Promise<void> {
  const media = { source: story.buffer! };
  const extra = { caption: getStoryCaption(story, task).slice(0, 1024) };
  if (story.mediaType === 'photo') {
    await bot.telegram.sendPhoto(task.chatId, media, extra);
  } else {
    await bot.telegram.sendVideo(task.chatId, media, extra);
  }
}

/**
 * Sends paginated stories to the user (i.e., a batch/page of stories).
 * Paid Stars deliveries also use this path because they refetch immutable
 * story IDs. Large paid bundles are split into Telegram-safe groups of ten.
 */
export async function sendPaginatedStories({
  stories,
  task,
}: SendPaginatedStoriesArgs) {
  const mapped: MappedStoryItem[] = mapStories(stories);

  mapped.forEach((story) => {
    story.source = {
      ...(story.source ?? {}),
      identifier: story.source?.identifier ?? task.link,
      displayName: story.source?.displayName ?? task.link,
    };
  });

  try {
    await sendTemporaryMessage(bot, task.chatId, t(task.locale, 'download.downloading')).catch(
      (err) => {
        console.error(
          `[sendPaginatedStories] Failed to send 'Downloading' message to ${task.chatId}:`,
          err
        );
      }
    );

    try {
      const controller = new AbortController();
      let lastProgress = Date.now();
      const onProgress = () => { lastProgress = Date.now(); };

      const globalTimeout = setTimeout(() => controller.abort(), 300000); // 5 min
      const activityInterval = setInterval(() => {
        if (Date.now() - lastProgress > 30000) {
          controller.abort();
        }
      }, 5000);

      const downloadResult = await downloadStories(mapped, 'pinned', onProgress, controller.signal);

      clearTimeout(globalTimeout);
      clearInterval(activityInterval);

      if (controller.signal.aborted) {
        throw new Error('Download timed out');
      }

      const uploadableStories: MappedStoryItem[] = mapped.filter(
        (x) => x.buffer && x.bufferSize! <= 50
      );

      const failedDownloads = downloadResult.failed.filter((story) => !story.buffer);

      if (uploadableStories.length > 0) {
        await sendTemporaryMessage(
          bot,
          task.chatId,
          t(task.locale, 'download.uploading')
        ).catch((err) => {
          console.error(
            `[sendPaginatedStories] Failed to send 'Uploading' message to ${task.chatId}:`,
            err
          );
        });

        for (let offset = 0; offset < uploadableStories.length; offset += TELEGRAM_MEDIA_GROUP_LIMIT) {
          const batch = uploadableStories.slice(offset, offset + TELEGRAM_MEDIA_GROUP_LIMIT);
          if (batch.length === 1) {
            await sendSingleStory(batch[0], task);
            continue;
          }
          await bot.telegram.sendMediaGroup(
            task.chatId,
            batch.map((story) => ({
              media: { source: story.buffer! },
              type: story.mediaType,
              caption: getStoryCaption(story, task).slice(0, 1024),
            }))
          );
        }
      } else {
        await bot.telegram
          .sendMessage(
            task.chatId,
            t(task.locale, 'pinned.none')
          )
          .catch((err) => {
            console.error(
              `[sendPaginatedStories] Failed to notify ${task.chatId} about no stories:`,
              err
            );
          });
      }

      if (failedDownloads.length > 0) {
        await sendStoryFallbacks(task, failedDownloads);
      }
    } catch (err) {
      await sendTemporaryMessage(
        bot,
        task.chatId,
        t(task.locale, 'download.timedOut')
      ).catch(() => {/* ignore */});
      throw err;
    }

  } catch (error) {
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    } as NotifyAdminParams);
    console.error('[sendPaginatedStories] Error occurred while sending paginated stories:', error);
    try {
      await bot.telegram
        .sendMessage(
          task.chatId,
          t(task.locale, 'pinned.error')
        )
        .catch((err) => {
          console.error(
            `[sendPaginatedStories] Failed to notify ${task.chatId} about general error:`,
            err
          );
        });
    } catch (_) {/* ignore */}
    throw error;
  }
  // No Effector event triggers; queue manager will handle progression!
}
