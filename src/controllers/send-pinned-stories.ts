import { Userbot } from 'config/userbot';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { chunkMediafiles, timeout } from 'lib'; // Assuming timeout is also from lib
import {
  cleanUpTempMessagesFired,
  tempMessageSent,
  UserInfo, 
} from 'services/stories-service';
import { Markup } from 'telegraf';
import { Api } from 'telegram';
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram'; // Import correct type

// Assuming downloadStories and mapStories are correctly imported or defined in this file
// If they are in './download-stories', the import should be:
import { downloadStories, mapStories, StoriesModel } from './download-stories';
import { notifyAdmin } from './send-message';
import { SendStoriesArgs } from './types'; // Assuming this type is correctly defined

export async function sendPinnedStories({ stories, task }: SendStoriesArgs): Promise<void> {
  let mapped: StoriesModel = mapStories(stories); 
  const isAdmin = task.chatId === BOT_ADMIN_ID.toString();

  let hasMorePages = false;
  const nextStories: Record<string, number[]> = {};
  const PER_PAGE = 5;

  if (!isAdmin && mapped.length > PER_PAGE) { 
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
    console.log(`[SendPinnedStories] Found ${storiesWithoutMedia.length} stories initially without media object after mapping. Attempting to re-fetch details.`);
    mapped = mapped.filter((x) => Boolean(x.media)); 

    const client = await Userbot.getInstance();
    const entity = await client.getEntity(task.link!); 

    const ids = storiesWithoutMedia.map((x) => x.id);

    if (ids.length > 0) { 
        try {
            const storiesWithMediaResult = await client.invoke(
              new Api.stories.GetStoriesByID({
                id: ids,
                peer: entity,
              })
            );
            const newlyMappedWithMedia = mapStories(storiesWithMediaResult.stories);
            newlyMappedWithMedia.forEach(newStory => {
                if (!mapped.some(existing => existing.id === newStory.id)) {
                    mapped.push(newStory);
                }
            });
            console.log(`[SendPinnedStories] Re-fetched and mapped ${newlyMappedWithMedia.length} stories.`);
        } catch (fetchError) {
            console.error(`[SendPinnedStories] Error re-fetching stories by ID:`, fetchError);
        }
    }
  }

  try {
    console.log(`[SendPinnedStories] [${task.link}] Preparing to download ${mapped.length} pinned stories.`);

    await bot.telegram.sendMessage(
      task.chatId!,
      '✅ Active stories processed!\n⏳ Downloading Pinned stories...'
    ).then(({ message_id }) => tempMessageSent(message_id))
      .catch(() => null);

    await downloadStories(mapped, 'pinned');
    console.log(`[SendPinnedStories] [${task.link}] downloadStories function completed.`);

    const uploadableStories = mapped.filter(
      (x) => x.buffer && x.bufferSize! <= 50 // bufferSize is in MB
    );

    console.log(`[SendPinnedStories] [${task.link}] Found ${uploadableStories.length} uploadable pinned stories after download.`);

    await bot.telegram.sendMessage(
      task.chatId!,
      `📥 ${uploadableStories.length} Pinned stories downloaded successfully!\n⏳ Uploading stories to Telegram...`
    ).then(({ message_id }) => tempMessageSent(message_id))
      .catch(() => null);

    if (uploadableStories.length > 0) {
      const chunkedList = chunkMediafiles(uploadableStories);
      console.log(`[SendPinnedStories] [${task.link}] Sending ${chunkedList.length} chunks.`);

      for (let i = 0; i < chunkedList.length; i++) {
        const album = chunkedList[i];
        console.log(`[SendPinnedStories] [${task.link}] Attempting to send chunk ${i + 1}/${chunkedList.length} with ${album.length} items.`);
        try {
            await bot.telegram.sendMediaGroup(
              task.chatId,
              album.map((x) => ({
                media: { source: x.buffer! }, 
                type: x.mediaType!, 
                caption: x.caption ?? `Pinned story ${x.id}`, 
              }))
            );
            console.log(`[SendPinnedStories] [${task.link}] Successfully sent chunk ${i + 1}.`);
        } catch (sendError) {
            console.error(`[SendPinnedStories] [${task.link}] Error sending media group chunk ${i + 1}:`, sendError);
        }
        await timeout(500); // Polite delay between sending chunks
      }
    } else {
      console.log(`[SendPinnedStories] [${task.link}] No uploadable stories (either 0 items or all too large).`);
      await bot.telegram.sendMessage(
        task.chatId,
        '❌ No Pinned stories could be sent. They might be too large or none were found after download.'
      );
    }

    if (hasMorePages) {
      const btnsData = Object.entries(nextStories).map(
        ([pages, nextStoriesIds]) => ({
          text: `📥 ${pages} 📥`,
          callback_data: `${task.link}&${JSON.stringify(nextStoriesIds)}`,
        })
      );

      // Correctly type the accumulator for the reduce function
      const keyboardRows = btnsData.reduce<InlineKeyboardButton[][]>((acc, currBtnData) => {
        const button = Markup.button.callback(currBtnData.text, currBtnData.callback_data);
        if (acc.length === 0 || acc[acc.length - 1].length >= 3) { // Max 3 buttons per row
          acc.push([button]);
        } else {
          acc[acc.length - 1].push(button);
        }
        return acc;
      }, []);

      if (keyboardRows.length > 0) {
        await bot.telegram.sendMessage(
          task.chatId,
          `Uploaded ${mapped.length} pinned stories for this page ✅\nMore pages available:`,
          Markup.inlineKeyboard(keyboardRows)
        );
      }
    }

    notifyAdmin({
      status: 'info',
      baseInfo: `📥 ${uploadableStories.length} Pinned stories uploaded for user ${task.link} (chatId: ${task.chatId})!`,
    });
    console.log(`[SendPinnedStories] [${task.link}] Processing finished successfully.`);
  } catch (error) {
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    });
    console.error(`[SendPinnedStories] [${task.link}] CRITICAL error occurred:`, error);
    try {
        await bot.telegram.sendMessage(task.chatId, ' Encountered an error while processing pinned stories. The admin has been notified.');
    } catch (e) { /* ignore */}
  } finally {
    console.log(`[SendPinnedStories] [${task.link}] Function execution complete.`);
  }
}
