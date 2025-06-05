import { Userbot } from 'config/userbot';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { chunkMediafiles, timeout } from 'lib'; // Assuming timeout is also from lib
import {
  cleanUpTempMessagesFired,
  tempMessageSent,
  UserInfo, // Assuming UserInfo is needed if 'task' is used more directly
} from 'services/stories-service';
import { Markup } from 'telegraf';
import { Api } from 'telegram';

// Assuming downloadStories and mapStories are correctly imported or defined in this file
// If they are in './download-stories', the import should be:
import { downloadStories, mapStories, StoriesModel } from './download-stories';
import { notifyAdmin } from './send-message';
import { SendStoriesArgs } from './types'; // Assuming this type is correctly defined

// Ensure this function is exported
export async function sendPinnedStories({ stories, task }: SendStoriesArgs): Promise<void> {
  // It's good practice for async functions that don't return a specific value
  // to be typed as Promise<void>
  let mapped: StoriesModel = mapStories(stories); // Ensure mapStories returns StoriesModel
  const isAdmin = task.chatId === BOT_ADMIN_ID.toString();

  let hasMorePages = false;
  const nextStories: Record<string, number[]> = {};
  const PER_PAGE = 5;

  if (!isAdmin && mapped.length > PER_PAGE) { // Check mapped.length after mapStories
    hasMorePages = true;
    const currentStories = mapped.slice(0, PER_PAGE); // Use mapped stories

    for (let i = PER_PAGE; i < mapped.length; i += PER_PAGE) {
      const from = i + 1;
      const to = Math.min(i + PER_PAGE, mapped.length);
      nextStories[`${from}-${to}`] = mapped
        .slice(i, i + PER_PAGE)
        .map((x) => x.id);
    }
    mapped = currentStories; // Update mapped to only the current page for non-admins
  }

  // This block seems to intend to re-fetch media if it's missing.
  // However, mapStories should ideally populate media if it's available.
  // If mapStories is already ensuring 'media' is present, this block might be simplified or re-evaluated.
  const storiesWithoutMedia = mapped.filter((x) => !x.media);
  if (storiesWithoutMedia.length > 0) {
    console.log(`[SendPinnedStories] Found ${storiesWithoutMedia.length} stories initially without media object after mapping. Attempting to re-fetch details.`);
    mapped = mapped.filter((x) => Boolean(x.media)); // Keep those that do have media

    const client = await Userbot.getInstance();
    const entity = await client.getEntity(task.link!); // Ensure task.link is not null/undefined

    const ids = storiesWithoutMedia.map((x) => x.id);

    if (ids.length > 0) { // Only invoke if there are IDs to fetch
        try {
            const storiesWithMediaResult = await client.invoke(
              new Api.stories.GetStoriesByID({
                id: ids,
                peer: entity,
              })
            );
            // mapStories again for the newly fetched items and add them
            // Ensure no duplicates are added if some were already in 'mapped'
            const newlyMappedWithMedia = mapStories(storiesWithMediaResult.stories);
            newlyMappedWithMedia.forEach(newStory => {
                if (!mapped.some(existing => existing.id === newStory.id)) {
                    mapped.push(newStory);
                }
            });
            console.log(`[SendPinnedStories] Re-fetched and mapped ${newlyMappedWithMedia.length} stories.`);
        } catch (fetchError) {
            console.error(`[SendPinnedStories] Error re-fetching stories by ID:`, fetchError);
            // Decide how to handle this: continue with what we have, or throw/return error
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

    // downloadStories should modify the 'mapped' items by reference, adding buffers
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
                media: { source: x.buffer! }, // Ensure buffer is not undefined
                type: x.mediaType!, // Ensure mediaType is 'photo' or 'video'
                caption: x.caption ?? `Pinned story ${x.id}`, // More specific caption
              }))
            );
            console.log(`[SendPinnedStories] [${task.link}] Successfully sent chunk ${i + 1}.`);
        } catch (sendError) {
            console.error(`[SendPinnedStories] [${task.link}] Error sending media group chunk ${i + 1}:`, sendError);
            // Consider if you want to notify the user about partial failure
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
      const btns = Object.entries(nextStories).map(
        ([pages, nextStoriesIds]) => ({
          text: `📥 ${pages} 📥`,
          // Ensure callback_data is well-formed
          callback_data: `${task.link}&${JSON.stringify(nextStoriesIds)}`,
        })
      );

      // Ensure btns is an array of arrays for inlineKeyboard
      const keyboardRows = btns.reduce<Markup.button.CallbackButton[][]>((acc, curr, index) => {
        const chunkIndex = Math.floor(index / 3); // Max 3 buttons per row
        if (!acc[chunkIndex]) {
          acc[chunkIndex] = [];
        }
        acc[chunkIndex].push(Markup.button.callback(curr.text, curr.callback_data));
        return acc;
      }, []);

      if (keyboardRows.length > 0) {
        await bot.telegram.sendMessage(
          task.chatId,
          `Uploaded ${mapped.length}/${stories.length} pinned stories for this page ✅\nMore pages available:`,
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
    // cleanUpTempMessagesFired was called here, but it's better if this is triggered by taskDone in stories-service
    // This ensures cleanup happens after all parts of sendStoriesFx (including other helpers) are done.
    console.log(`[SendPinnedStories] [${task.link}] Function execution complete.`);
  }
}
