import { bot, GLOBAL_STORIES_PAGE_SIZE, GLOBAL_STORIES_CALLBACK_PREFIX } from 'index';
import { chunkMediafiles, sendTemporaryMessage } from 'lib';
import { t } from 'lib/i18n';
import { downloadStories } from 'controllers/download-stories';
import { SendStoriesArgs, MappedStoryItem, NotifyAdminParams, UserInfo } from 'types';
import { notifyAdmin } from 'controllers/send-message';

// =========================================================================
// Sends stories from the global feed.
// =========================================================================
async function updatePaginationControls(task: UserInfo, batchSize: number) {
  const messageId = task.globalStoriesMessageId;
  if (!messageId) {
    return;
  }

  const hasMore = batchSize >= GLOBAL_STORIES_PAGE_SIZE;
  try {
    if (hasMore) {
      const nextOffset = (task.offset || 0) + GLOBAL_STORIES_PAGE_SIZE;
      await bot.telegram.editMessageReplyMarkup(
        task.chatId,
        messageId,
        undefined,
        {
          inline_keyboard: [
            [
              {
                text: `${t(task.locale, 'pagination.next')} ${GLOBAL_STORIES_PAGE_SIZE}`,
                callback_data: `${GLOBAL_STORIES_CALLBACK_PREFIX}${nextOffset}`,
              },
            ],
          ],
        },
      );
    } else {
      await bot.telegram.editMessageReplyMarkup(task.chatId, messageId, undefined, undefined);
    }
  } catch (error) {
    console.error('[sendGlobalStories] Failed to update pagination controls:', error);
  }
}

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

    await updatePaginationControls(task, stories.length);

    notifyAdmin({ task, status: 'info', baseInfo: `📥 Global stories uploaded to user!` } as NotifyAdminParams);
  } catch (error) {
    notifyAdmin({ status: 'error', task, errorInfo: { cause: error } } as NotifyAdminParams);
    console.error('[sendGlobalStories] Error sending global stories:', error);
    try {
      await bot.telegram.sendMessage(task.chatId, t(task.locale, 'global.error'));
    } catch (_) {/* ignore */}
    await updatePaginationControls(task, 0);
    throw error;
  }
}
