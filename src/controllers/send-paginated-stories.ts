import { bot } from 'index';
import { Api } from 'telegram';

import { downloadStories, mapStories } from './download-stories';
import { notifyAdmin } from './send-message';
import { SendStoriesArgs } from './types';

/**
 * Sends paginated stories to the user (i.e., a batch/page of stories).
 * @param stories - Array of story items to send.
 * @param task    - User/task context.
 */
export async function sendPaginatedStories({
  stories,
  task,
}: Omit<SendStoriesArgs, 'stories'> & { stories: Api.TypeStoryItem[] }) {
  const mapped = mapStories(stories);

  try {
    // Notify user that download is starting
    await bot.telegram.sendMessage(task.chatId, '⏳ Downloading...').catch(() => null);

    // Actually download the stories (media files to buffer)
    await downloadStories(mapped, 'pinned');

    // Filter only those stories which have a buffer (media) and are not too large
    const uploadableStories = mapped.filter(
      (x) => x.buffer && x.bufferSize! <= 50 // skip too large files
    );

    if (uploadableStories.length > 0) {
      // Notify user that upload is starting
      await bot.telegram.sendMessage(task.chatId, '⏳ Uploading to Telegram...').catch(() => null);

      // Send all media as a group (album)
      await bot.telegram.sendMediaGroup(
        task.chatId,
        uploadableStories.map((x) => ({
          media: { source: x.buffer! },
          type: x.mediaType,
          caption: x.caption ?? 'Active stories',
        }))
      );
    } else {
      await bot.telegram.sendMessage(
        task.chatId,
        '❌ No paginated stories could be sent. They might be too large or none were found.'
      ).catch(() => null);
    }

    // Notify admin for logging and monitoring
    notifyAdmin({
      status: 'info',
      baseInfo: `📥 Paginated stories uploaded to user!`,
    });
  } catch (error) {
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    });
    console.error('[sendPaginatedStories] Error occurred while sending paginated stories:', error);
    try {
      await bot.telegram.sendMessage(task.chatId, 'An error occurred while sending these stories. The admin has been notified.').catch(() => null);
    } catch (_) {/* ignore */}
  }
  // No Effector event triggers; queue manager will handle progression!
}
