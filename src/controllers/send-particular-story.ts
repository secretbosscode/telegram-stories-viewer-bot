// src/controllers/send-particular-story.ts

import { bot } from 'index'; // Corrected path to use tsconfig alias
import { Api } from 'telegram';

// CORRECTED: Import types from your central types.ts file
import { SendParticularStoryArgs, UserInfo, MappedStoryItem, NotifyAdminParams } from 'types'; // <--- Corrected import path & added MappedStoryItem, NotifyAdminParams

// Corrected import path for downloadStories and mapStories
import { downloadStories, mapStories } from 'controllers/download-stories'; // <--- Corrected import path
import { notifyAdmin } from 'controllers/send-message'; // <--- Corrected import path


/**
 * Sends a particular story to the user.
 * @param story - The story item to send.
 * @param task  - The user/task information.
 */
export async function sendParticularStory({
  story,
  task,
}: SendParticularStoryArgs) { // <--- Using the imported SendParticularStoryArgs
  // `mapStories` expects an array, so pass the single story in an array.
  const mapped: MappedStoryItem[] = mapStories([story]); // <--- Explicitly typed mapped to MappedStoryItem[]

  try {
    // Notify user that download is starting
    await bot.telegram.sendMessage(task.chatId, '⏳ Downloading...').catch(() => null);

    // Actually download the story (media file to buffer)
    await downloadStories(mapped, 'active'); // 'active' is a string literal, ok.

    const singleStory: MappedStoryItem = mapped[0]; // <--- Explicitly typed singleStory

    if (singleStory && singleStory.buffer) { // <--- Added check for singleStory existence
      // Notify user that upload is starting
      await bot.telegram.sendMessage(task.chatId, '⏳ Uploading to Telegram...').catch(() => null);

      // Send the media group (single file as an array)
      await bot.telegram.sendMediaGroup(task.chatId, [
        {
          media: { source: singleStory.buffer },
          type: singleStory.mediaType, // `mediaType` is already 'photo' | 'video' from MappedStoryItem
          caption:
            `${singleStory.caption ? `${singleStory.caption}\n` : ''}` +
            `\n📅 Post date: ${singleStory.date.toUTCString()}`,
        },
      ]);
    } else {
      // Notify user if download failed
      await bot.telegram.sendMessage(task.chatId, '❌ Could not retrieve the requested story.').catch(() => null);
    }

    // Notify admin for monitoring
    notifyAdmin({
      status: 'info',
      baseInfo: `📥 Particular story uploaded to user!`,
    } as NotifyAdminParams); // <--- Added type assertion for notifyAdmin params

  } catch (error) { // <--- Error can be 'unknown' or 'any' if not specified
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    } as NotifyAdminParams); // <--- Added type assertion for notifyAdmin params
    console.error('[sendParticularStory] Error occurred while sending story:', error);
    try {
      await bot.telegram.sendMessage(task.chatId, 'An error occurred while sending this story. The admin has been notified.').catch(() => null);
    } catch (_) {/* ignore */}
    throw error; // Essential for Effector's .fail to trigger
  }
  // No more Effector event triggers, just let queue logic handle cleanup!
}
