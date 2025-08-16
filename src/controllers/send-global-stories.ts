import { bot } from 'index';
import { chunkMediafiles, sendTemporaryMessage } from 'lib';
import { t } from 'lib/i18n';
import { downloadStories } from 'controllers/download-stories';
import { SendStoriesArgs, MappedStoryItem, NotifyAdminParams } from 'types';
import { notifyAdmin } from 'controllers/send-message';

// =========================================================================
// Sends stories from the global feed.
// =========================================================================
export async function sendGlobalStories({ stories, task }: SendStoriesArgs) {
  let mapped: MappedStoryItem[] = stories;

  try {
    await sendTemporaryMessage(bot, task.chatId, t(task.locale, 'global.downloading')).catch(() => {});

    await downloadStories(mapped, 'active');

    const uploadableStories = mapped.filter(
      (x: MappedStoryItem) => x.buffer && x.bufferSize! <= 50
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
            caption: isSingle ? undefined : x.caption ?? t(task.locale, 'global.label'),
          }))
        );
        if (isSingle) {
          const caption = album[0].caption ?? t(task.locale, 'global.label');
          await sendTemporaryMessage(bot, task.chatId, caption).catch(() => {});
        }
      }
    } else {
      await bot.telegram.sendMessage(task.chatId, t(task.locale, 'global.none'));
    }

    notifyAdmin({ status: 'info', baseInfo: `📥 Global stories uploaded to user!` } as NotifyAdminParams);
  } catch (error) {
    notifyAdmin({ status: 'error', task, errorInfo: { cause: error } } as NotifyAdminParams);
    console.error('[sendGlobalStories] Error sending global stories:', error);
    try {
      await bot.telegram.sendMessage(task.chatId, t(task.locale, 'global.error'));
    } catch (_) {/* ignore */}
    throw error;
  }
}
