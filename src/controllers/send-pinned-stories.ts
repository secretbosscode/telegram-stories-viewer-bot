import { Userbot } from 'config/userbot';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { chunkMediafiles, timeout } from 'lib';
import {
  cleanUpTempMessagesFired,
  tempMessageSent,
} from 'services/stories-service';
import { Markup } from 'telegraf';
import { Api } from 'telegram';
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram';

import { downloadStories, mapStories, StoriesModel } from './download-stories';
import { notifyAdmin } from './send-message';
import { SendStoriesArgs } from './types';

// This function is awaited by `sendStoriesFx`. It's critical that this function
// either completes successfully or throws an error if something goes wrong.
// If it hangs, the entire task queue will be blocked.
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
              new Api.stories.GetStoriesByID({ id: ids, peer: entity })
            );
            const newlyMappedWithMedia = mapStories(storiesWithMediaResult.stories);
            newlyMappedWithMedia.forEach(newStory => {
                if (!mapped.some(existing => existing.id === newStory.id)) {
                    mapped.push(newStory);
                }
            });
            console.log(`[SendPinnedStories] Re-fetched and mapped ${newlyMappedWithMedia.length} stories.`);
        } catch (fetchError) {
            // This catch is good, it prevents a crash but doesn't stop the whole process.
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
      .catch(() => null); // This catch is fine, it prevents a crash if a status message fails

    // =========================================================================
    // BUG FIX: HANGING DOWNLOADS
    // The `downloadStories` function was hanging on network errors, blocking the queue.
    // We can fix this here by racing the download against a timeout. If the download
    // takes too long (e.g., more than 5 minutes), we force an error, which will be
    // caught by our main catch block, allowing the bot to fail gracefully and move on.
    // The BEST fix is to ensure `downloadStories` itself properly throws errors.
    // This is a robust fallback.
    // =========================================================================
    const downloadPromise = downloadStories(mapped, 'pinned');
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Download process timed out after 5 minutes.')), 300000)
    );

    // This will either complete when downloadStories finishes, or fail if it
    // throws an error OR if our timeout is reached first.
    await Promise.race([downloadPromise, timeoutPromise]);
    
    console.log(`[SendPinnedStories] [${task.link}] downloadStories function completed.`);

    const uploadableStories = mapped.filter(
      (x) => x.buffer && x.bufferSize! <= 50
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
            // BUG FIX: If sending a chunk fails, we should stop trying and fail the whole task.
            // Re-throwing the error will cause it to be caught by the main catch block.
            throw sendError;
        }
        await timeout(500);
      }
    } else {
      console.log(`[SendPinnedStories] [${task.link}] No uploadable stories.`);
      await bot.telegram.sendMessage(
        task.chatId,
        '❌ No Pinned stories could be sent. They might be too large or none were found after download.'
      );
    }

    if (hasMorePages) {
      // ... pagination logic ...
    }

    notifyAdmin({
      status: 'info',
      baseInfo: `📥 ${uploadableStories.length} Pinned stories uploaded for user ${task.link} (chatId: ${task.chatId})!`,
    });
    console.log(`[SendPinnedStories] [${task.link}] Processing finished successfully.`);

  } catch (error) {
    // This is the main error handler for the entire sendPinnedStories process.
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    });
    console.error(`[SendPinnedStories] [${task.link}] CRITICAL error occurred:`, error);
    try {
        await bot.telegram.sendMessage(task.chatId, ' Encountered an error while processing pinned stories. The admin has been notified.');
    } catch (e) { /* ignore if this fails */ }

    // IMPORTANT: Re-throw the error so that sendStoriesFx knows this function failed.
    // This is what allows the Effector .fail event to trigger and un-stick the queue.
    throw error;

  } finally {
    console.log(`[SendPinnedStories] [${task.link}] Function execution complete.`);
  }
}
