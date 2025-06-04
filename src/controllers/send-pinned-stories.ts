import { Userbot } from 'config/userbot';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { chunkMediafiles } from 'lib';
import {
  cleanUpTempMessagesFired,
  tempMessageSent,
} from 'services/stories-service';
import { Markup } from 'telegraf';
import { Api } from 'telegram';

import { downloadStories, mapStories } from './download-stories';
import { notifyAdmin } from './send-message';
import { SendStoriesArgs } from './types';

export async function sendPinnedStories({ stories, task }: SendStoriesArgs) {
  let mapped = mapStories(stories);
  const isAdmin = task.chatId === BOT_ADMIN_ID.toString();

  let hasMorePages = false;
  const nextStories: Record<string, number[]> = {};
  const PER_PAGE = 5;

  if (!isAdmin && stories.length > PER_PAGE) {
    hasMorePages = true;

    const currentStories = mapped.slice(0, PER_PAGE);

    for (let i = PER_PAGE; i < mapped.length; i += PER_PAGE) {
      const from = i + 1;
      const to = Math.min(i + PER_PAGE, mapped.length);
      nextStories[`${from}-${to}`] = mapped
        .slice(i, i + PER_PAGE)
        .map((x) => x.id);
    }

    mapped = currentStories;
  }

  const storiesWithoutMedia = mapped.filter((x) => !x.media);

  if (storiesWithoutMedia.length > 0) {
    mapped = mapped.filter((x) => Boolean(x.media));

    const client = await Userbot.getInstance();
    const entity = await client.getEntity(task.link!);

    const ids = storiesWithoutMedia.map((x) => x.id);

    const storiesWithMedia = await client.invoke(
      new Api.stories.GetStoriesByID({
        id: ids,
        peer: entity,
      })
    );

    mapped.push(...mapStories(storiesWithMedia.stories));
  }

  try {
    console.log(`downloading ${mapped.length} pinned stories`);

    await bot.telegram.sendMessage(
      task.chatId!,
      '✅ Active stories processed!\n⏳ Downloading Pinned stories...'
    ).then(({ message_id }) => tempMessageSent(message_id))
      .catch(() => null);

    await downloadStories(mapped, 'pinned');

    const uploadableStories = mapped.filter(
      (x) => x.buffer && x.bufferSize! <= 50
    );

    console.log(`pinned stories downloaded`);
    console.log(`sending ${uploadableStories.length} uploadable pinned stories`);

    await bot.telegram.sendMessage(
      task.chatId!,
      `📥 ${uploadableStories.length} Pinned stories downloaded successfully!\n⏳ Uploading stories to Telegram...`
    ).then(({ message_id }) => tempMessageSent(message_id))
      .catch(() => null);

    if (uploadableStories.length > 0) {
      const chunkedList = chunkMediafiles(uploadableStories);

      for (const album of chunkedList) {
        await bot.telegram.sendMediaGroup(
          task.chatId,
          album.map((x) => ({
            media: { source: x.buffer! },
            type: x.mediaType,
            caption: x.caption ?? 'Pinned stories',
          }))
        );
      }
    } else {
      await bot.telegram.sendMessage(
        task.chatId,
        '❌ Cannot download Pinned stories, most likely they have too large size to send them via bot'
      );
    }

    if (hasMorePages) {
      const btns = Object.entries(nextStories).map(
        ([pages, nextStoriesIds]) => ({
          text: `📥 ${pages} 📥`,
          callback_data: `${task.link}&${JSON.stringify(nextStoriesIds)}`,
        })
      );

      const res = btns.reduce<any>((acc, curr, index) => {
        const chunkIndex = Math.floor(index / 3);
        if (!acc[chunkIndex]) {
          acc[chunkIndex] = [];
        }
        acc[chunkIndex].push(curr);
        return acc;
      }, []);

      await bot.telegram.sendMessage(
        task.chatId,
        `Uploaded ${PER_PAGE}/${stories.length} pinned stories ✅`,
        Markup.inlineKeyboard(res)
      );
    }

    notifyAdmin({
      status: 'info',
      baseInfo: `📥 ${uploadableStories.length} Pinned stories uploaded to user!`,
    });
  } catch (error) {
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    });
    console.log('error occurred on sending PINNED stories:', error);
  }

  cleanUpTempMessagesFired();
}
