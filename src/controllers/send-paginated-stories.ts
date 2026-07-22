// src/controllers/send-paginated-stories.ts

import { bot } from 'index'; // Corrected path to use tsconfig alias
import { sendTemporaryMessage } from 'lib';
import { t } from "lib/i18n";

// CORRECTED: Import types from your central types.ts file
import { SendPaginatedStoriesArgs, MappedStoryItem } from 'types';

// Corrected import path for downloadStories and mapStories
import { downloadStories, mapStories } from 'controllers/download-stories';
import { notifyAdmin } from 'controllers/send-message';
import { NotifyAdminParams } from 'types';
import { sendStoryFallbacks } from 'controllers/story-fallback';

const TELEGRAM_MEDIA_GROUP_LIMIT = 10;

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

        const isSingle = uploadableStories.length === 1;
        for (let offset = 0; offset < uploadableStories.length; offset += TELEGRAM_MEDIA_GROUP_LIMIT) {
          const batch = uploadableStories.slice(offset, offset + TELEGRAM_MEDIA_GROUP_LIMIT);
          await bot.telegram.sendMediaGroup(
            task.chatId,
            batch.map((x) => ({
              media: { source: x.buffer! },
              type: x.mediaType,
              caption: isSingle
                ? undefined
                : x.caption ?? (task.starsUnlocked
                  ? `Story from ${task.link}`
                  : `Pinned story ${x.id}`),
            }))
          );
        }

        if (isSingle) {
          const story = uploadableStories[0];
          await sendTemporaryMessage(
            bot,
            task.chatId,
            story.caption ?? (task.starsUnlocked
              ? `Story from ${task.link}`
              : `Pinned story ${story.id}`),
          ).catch((err) => {
            console.error(
              `[sendPaginatedStories] Failed to send temporary caption to ${task.chatId}:`,
              err,
            );
          });
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
