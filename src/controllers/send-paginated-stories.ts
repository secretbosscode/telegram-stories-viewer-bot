import { bot } from 'index'; // Corrected path to use tsconfig alias
import { Api } from 'telegram';

// CORRECTED: Import types from your central types.ts file
import { SendPaginatedStoriesArgs, MappedStoryItem, NotifyAdminParams } from 'types'; // <--- Corrected import path & added MappedStoryItem, NotifyAdminParams

// Corrected import path for downloadStories and mapStories
import { downloadStories, mapStories } from 'controllers/download-stories'; // <--- Corrected import path
import { notifyAdmin } from 'controllers/send-message'; // <--- Corrected import path


/**
 * Sends paginated stories to the user (i.e., a batch/page of stories).
 * @param stories - Array of story items to send.
 * @param task    - User/task context.
 */
export async function sendPaginatedStories({
  stories,
  task,
}: SendPaginatedStoriesArgs) { // <--- Using the imported SendPaginatedStoriesArgs
  // `mapStories` expects Api.TypeStoryItem[], and `stories` here is Api.TypeStoryItem[]
  const mapped: MappedStoryItem[] = mapStories(stories); // <--- Explicitly typed mapped to MappedStoryItem[]

  try {
    // Notify user that download is starting
    await bot.telegram.sendMessage(task.chatId, '⏳ Downloading...').catch(() => null);

    // Actually download the stories (media files to buffer)
    await downloadStories(mapped, 'pinned'); // 'pinned' is a string literal, ok.

    // Filter only those stories which have a buffer (media) and are not too large
    const uploadableStories: MappedStoryItem[] = mapped.filter( // <--- Explicitly typed uploadableStories
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
          type: x.mediaType, // `mediaType` is already 'photo' | 'video' from MappedStoryItem
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
    } as NotifyAdminParams); // <--- Added type assertion for notifyAdmin params

  } catch (error) { // <--- Error can be 'unknown' or 'any' if not specified
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    } as NotifyAdminParams); // <--- Added type assertion for notifyAdmin params
    console.error('[sendPaginatedStories] Error occurred while sending paginated stories:', error);
    try {
      await bot.telegram.sendMessage(task.chatId, 'An error occurred while sending these stories. The admin has been notified.').catch(() => null);
    } catch (_) {/* ignore */}
    throw error; // Essential for Effector's .fail to trigger
  }
  // No Effector event triggers; queue manager will handle progression!
}
