// src/controllers/send-archived-stories.ts

import { Userbot } from 'config/userbot';
import { bot } from 'index';
import { sendTemporaryMessage } from 'lib';
import { uploadStoryMedia } from 'controllers/upload-story-media';
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

    const uploadableStories = mapped.filter((story) => story.buffer);
    const fallbackCandidates = downloadResult.failed.filter((story) => !story.buffer);

    const deliveredIds = new Set<number>();
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

      const tooLarge = await uploadStoryMedia(
        task.chatId, uploadableStories,
        (story) => [story.caption, task.link].filter(Boolean).join('\n'),
        deliveredIds,
      );
      fallbackCandidates.push(...tooLarge);
    }

    if (fallbackCandidates.length > 0) {
      const fallbackIds = await sendStoryFallbacks(task, fallbackCandidates);
      for (const id of fallbackIds) deliveredIds.add(id);
    }
    if (deliveredIds.size === 0) {
      await bot.telegram.sendMessage(task.chatId, t(task.locale, 'archive.none'));
    }

    notifyAdmin({
      task,
      status: 'info',
      baseInfo: `📥 ${deliveredIds.size} Archived stories delivered to user!`,
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
