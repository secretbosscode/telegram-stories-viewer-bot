// src/controllers/send-archived-stories.ts

import { Userbot } from 'config/userbot';
import { bot } from 'index';
import { chunkMediafiles, sendTemporaryMessage } from 'lib';
import { t } from 'lib/i18n';
import { Api } from 'telegram';

import { SendStoriesArgs, MappedStoryItem, StoriesModel, NotifyAdminParams } from 'types';
import { downloadStories, mapStories } from 'controllers/download-stories';
import { notifyAdmin } from 'controllers/send-message';
import { sendStoryFallbacks } from 'controllers/story-fallback';
import { ensureStealthMode } from 'services/stealth-mode';

/**
 * Sends archived stories to the user.
 * Similar to send-active-stories and send-pinned-stories but for archived content.
 */
export async function sendArchivedStories({ stories, task }: SendStoriesArgs) {
  let mapped: StoriesModel = stories;

  const storiesWithoutMedia: MappedStoryItem[] = mapped.filter((x: MappedStoryItem) => !x.media);
  if (storiesWithoutMedia.length > 0) {
    mapped = mapped.filter((x: MappedStoryItem) => Boolean(x.media));
    try {
      const client = await Userbot.getInstance();
      const entity = await client.getEntity(task.link!);
      const ids = storiesWithoutMedia.map((x: MappedStoryItem) => x.id);
      await ensureStealthMode();
      const storiesWithMediaApi = await client.invoke(
        new Api.stories.GetStoriesByID({ id: ids, peer: entity })
      );
      mapped.push(...mapStories(storiesWithMediaApi.stories));
    } catch (e) {
      console.error('[sendArchivedStories] Error re-fetching stories without media:', e);
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
      t(task.locale, 'archive.downloading')
    ).catch((err) => {
      console.error(
        `[sendArchivedStories] Failed to send 'Downloading Archived stories' message to ${task.chatId}:`,
        err
      );
    });

    const downloadResult = await downloadStories(mapped, 'archived');

    const uploadableStories: MappedStoryItem[] = mapped.filter(
      (x: MappedStoryItem) => x.buffer && x.bufferSize! <= 47
    );

    const failedDownloads = downloadResult.failed.filter((story) => !story.buffer);

    if (uploadableStories.length > 0) {
      await sendTemporaryMessage(
        bot,
        task.chatId,
        t(task.locale, 'archive.uploading', { count: uploadableStories.length })
      ).catch((err) => {
        console.error(
          `[sendArchivedStories] Failed to send 'Uploading' message to ${task.chatId}:`,
          err
        );
      });

      const chunkedList = chunkMediafiles(uploadableStories);
      for (const album of chunkedList) {
        // A media group must carry 2-10 items; a chunk can legitimately hold one
        // when a single story fills the size budget.
        if (album.length === 1) {
          const single = album[0];
          const media = { source: single.buffer! };
          const extra = {
            caption: [single.caption, task.link].filter(Boolean).join('\n').slice(0, 1024),
            ...(single.noforwards ? { protect_content: true } : {}),
          };
          if (single.mediaType === 'photo') {
            await bot.telegram.sendPhoto(task.chatId, media, extra);
          } else {
            await bot.telegram.sendVideo(task.chatId, media, extra);
          }
          continue;
        }
        await bot.telegram.sendMediaGroup(
          task.chatId,
          album.map((x: MappedStoryItem) => ({
            media: { source: x.buffer! },
            type: x.mediaType,
            caption: [x.caption, task.link].filter(Boolean).join('\n'),
          })),
          album.some((x: MappedStoryItem) => x.noforwards)
            ? { protect_content: true }
            : undefined,
        );
      }
    } else {
      await bot.telegram.sendMessage(
        task.chatId,
        t(task.locale, 'archive.none')
      );
    }

    if (failedDownloads.length > 0) {
      await sendStoryFallbacks(task, failedDownloads);
    }

    notifyAdmin({
      task,
      status: 'info',
      baseInfo: `📥 ${uploadableStories.length} Archived stories uploaded to user!`,
    } as NotifyAdminParams);
  } catch (error: any) {
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    } as NotifyAdminParams);
    console.error('[sendArchivedStories] Error sending ARCHIVED stories:', error);
    try {
      await bot.telegram
        .sendMessage(
          task.chatId,
          t(task.locale, 'archive.error')
        )
        .catch((err) => {
          console.error(
            `[sendArchivedStories] Failed to notify ${task.chatId} about general error:`,
            err
          );
        });
    } catch (_) {/* ignore */}
    throw error;
  }
}
