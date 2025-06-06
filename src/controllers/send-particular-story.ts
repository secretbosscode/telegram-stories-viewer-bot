import { bot } from 'index';
import { Api } from 'telegram';

import { downloadStories, mapStories } from './download-stories';
import { notifyAdmin } from './send-message';
import { SendStoriesArgs } from './types';
// Import UserInfo from the correct types file if needed

/**
 * Sends a particular story to the user.
 * @param story - The story item to send.
 * @param task  - The user/task information.
 */
export async function sendParticularStory({
  story,
  task,
}: Omit<SendStoriesArgs, 'stories'> & { story: Api.TypeStoryItem }) {
  const mapped = mapStories([story]);
  try {
    // Notify user that download is starting
    await bot.telegram.sendMessage(task.chatId, '⏳ Downloading...').catch(() => null);

    // Actually download the story (media file to buffer)
    await downloadStories(mapped, 'active');

    const singleStory = mapped[0];

    if (singleStory.buffer) {
      // Notify user that upload is starting
      await bot.telegram.sendMessage(task.chatId, '⏳ Uploading to Telegram...').catch(() => null);

      // Send the media group (single file as an array)
      await bot.telegram.sendMediaGroup(task.chatId, [
        {
          media: { source: singleStory.buffer },
          type: singleStory.mediaType,
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
    });
  } catch (error) {
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    });
    console.error('[sendParticularStory] Error occurred while sending story:', error);
    try {
      await bot.telegram.sendMessage(task.chatId, 'An error occurred while sending this story. The admin has been notified.').catch(() => null);
    } catch (_) {/* ignore */}
  }
  // No more Effector event triggers, just let queue logic handle cleanup!
}
