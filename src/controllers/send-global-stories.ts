import { Userbot } from 'config/userbot';
import { bot } from 'index';
import { chunkMediafiles, sendTemporaryMessage } from 'lib';
import { t } from 'lib/i18n';
import { Api } from 'telegram';

import { SendStoriesArgs, MappedStoryItem, StoriesModel } from 'types';
import { downloadStories, mapStories } from 'controllers/download-stories';

/**
 * Sends stories from the global feed (contacts) to the user.
 */
export async function sendGlobalStories({ stories, task }: SendStoriesArgs) {
  let mapped: StoriesModel = stories;

  const storiesWithoutMedia: MappedStoryItem[] = mapped.filter((x: MappedStoryItem) => !x.media);
  if (storiesWithoutMedia.length > 0) {
    mapped = mapped.filter((x: MappedStoryItem) => Boolean(x.media));
    try {
      const client = await Userbot.getInstance();
      const ids = storiesWithoutMedia.map((x: MappedStoryItem) => x.id);
      const storiesWithMediaApi = await client.invoke(
        new Api.stories.GetStoriesByID({ id: ids })
      );
      mapped.push(...mapStories(storiesWithMediaApi.stories));
    } catch (e) {
      console.error('[sendGlobalStories] Error re-fetching stories without media:', e);
    }
  }

  await sendTemporaryMessage(
    bot,
    task.chatId,
    t(task.locale, 'global.downloading')
  ).catch(() => {});

  await downloadStories(mapped, 'active');

  const uploadableStories: MappedStoryItem[] = mapped.filter(
    (x: MappedStoryItem) => x.buffer && x.bufferSize! <= 47
  );

  if (uploadableStories.length > 0) {
    await sendTemporaryMessage(
      bot,
      task.chatId,
      t(task.locale, 'global.uploading', { count: uploadableStories.length })
    ).catch(() => {});

    const chunkedList = chunkMediafiles(uploadableStories);
    for (const album of chunkedList) {
      const isSingle = album.length === 1;
      await bot.telegram.sendMediaGroup(
        task.chatId,
        album.map((x: MappedStoryItem) => ({
          media: { source: x.buffer! },
          type: x.mediaType,
          caption: isSingle ? undefined : x.caption ?? undefined,
        }))
      );
      if (isSingle) {
        const caption = album[0].caption ?? 'Story';
        await sendTemporaryMessage(bot, task.chatId, caption).catch(() => {});
      }
    }
  } else {
    await bot.telegram.sendMessage(
      task.chatId,
      t(task.locale, 'global.none')
    );
  }
}
