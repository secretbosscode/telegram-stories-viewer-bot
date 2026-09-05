import { bot, GLOBAL_STORIES_PAGE_SIZE, GLOBAL_STORIES_CALLBACK_PREFIX } from 'index';
import { chunkMediafiles, sendTemporaryMessage } from 'lib';
import { t } from 'lib/i18n';
import { downloadStories, mapStories } from 'controllers/download-stories';
import { SendStoriesArgs, MappedStoryItem, NotifyAdminParams, UserInfo } from 'types';
import { notifyAdmin } from 'controllers/send-message';
import { withPeerStoriesTemporarilyVisible } from 'services/hidden-stories';
import { Userbot } from 'config/userbot';
import { Api } from 'telegram';

function extractStoryItems(result: any): Api.TypeStoryItem[] {
  if (!result) {
    return [];
  }

  if (Array.isArray(result.stories)) {
    return result.stories;
  }

  if (Array.isArray(result?.stories?.stories)) {
    return result.stories.stories;
  }

  return [];
}

// =========================================================================
// Sends stories from the global feed.
// =========================================================================
async function updatePaginationControls(task: UserInfo) {
  const messageId = task.globalStoriesMessageId;
  if (!messageId) {
    return;
  }

  const hasMore = Boolean(task.globalStoriesHasMore);
  const stateToken = task.globalStoriesState;
  const hiddenFlag = task.includeHiddenStories ? '1' : '0';
  try {
    if (hasMore && stateToken) {
      await bot.telegram.editMessageReplyMarkup(
        task.chatId,
        messageId,
        undefined,
        {
          inline_keyboard: [
            [
              {
                text: `${t(task.locale, 'pagination.next')} ${GLOBAL_STORIES_PAGE_SIZE}`,
                callback_data: `${GLOBAL_STORIES_CALLBACK_PREFIX}${hiddenFlag}:${stateToken}`,
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

export async function sendGlobalStories({ stories, task, storyOwnersById }: SendStoriesArgs) {
  let mapped: MappedStoryItem[] = stories;

  try {
    await sendTemporaryMessage(bot, task.chatId, t(task.locale, 'global.downloading')).catch(() => {});

    await downloadStories(mapped, 'active');

    const storiesNeedingRefresh = mapped.filter(
      (story: MappedStoryItem) => !story.buffer && !!story.owner
    );

    if (storiesNeedingRefresh.length > 0) {
      const client = await Userbot.getInstance();

      for (const story of storiesNeedingRefresh) {
        const peer = story.owner;
        if (!peer) {
          continue;
        }

        try {
          await withPeerStoriesTemporarilyVisible(peer, async () => {
            const response = await client.invoke(
              new Api.stories.GetStoriesByID({ peer, id: [story.id] })
            );

            const refreshedItems = extractStoryItems(response);
            if (refreshedItems.length === 0) {
              console.warn(`[sendGlobalStories] Hidden story ${story.id} returned no media after refresh.`);
              return;
            }

            const ownersLookup = story.owner
              ? { [story.id]: story.owner }
              : storyOwnersById;
            const remapped = mapStories(refreshedItems, ownersLookup);
            const refreshedStory = remapped.find((item) => item.id === story.id);

            if (!refreshedStory) {
              console.warn(`[sendGlobalStories] Hidden story ${story.id} missing from refreshed response.`);
              return;
            }

            story.caption = refreshedStory.caption;
            story.media = refreshedStory.media;
            story.mediaType = refreshedStory.mediaType;
            story.date = refreshedStory.date;
            story.noforwards = refreshedStory.noforwards;
            story.buffer = undefined;
            story.bufferSize = undefined;
          });
        } catch (error) {
          console.error(`[sendGlobalStories] Failed to re-fetch hidden story ${story.id}:`, error);
        }
      }

      await downloadStories(storiesNeedingRefresh, 'active');
    }

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
        // A media group must carry 2-10 items; a chunk can legitimately hold one
        // when a single story fills the size budget.
        if (album.length === 1) {
          const single = album[0];
          const media = { source: single.buffer! };
          const caption = single.caption ?? t(task.locale, 'global.label');
          const extra = {
            caption: caption.slice(0, 1024),
            ...(single.noforwards ? { protect_content: true } : {}),
          };
          if (single.mediaType === 'photo') {
            await bot.telegram.sendPhoto(task.chatId, media, extra);
          } else {
            await bot.telegram.sendVideo(task.chatId, media, extra);
          }
          continue;
        }
        await bot.telegram.sendMediaGroup(
          task.chatId,
          album.map((x: MappedStoryItem) => ({
            media: { source: x.buffer! },
            type: x.mediaType,
            caption: x.caption ?? t(task.locale, 'global.label'),
          })),
          album.some((x: MappedStoryItem) => x.noforwards)
            ? { protect_content: true }
            : undefined,
        );
      }
    } else {
      await bot.telegram.sendMessage(task.chatId, t(task.locale, 'global.none'));
    }

    await updatePaginationControls(task);

    notifyAdmin({ task, status: 'info', baseInfo: `📥 Global stories uploaded to user!` } as NotifyAdminParams);
  } catch (error) {
    notifyAdmin({ status: 'error', task, errorInfo: { cause: error } } as NotifyAdminParams);
    console.error('[sendGlobalStories] Error sending global stories:', error);
    try {
      await bot.telegram.sendMessage(task.chatId, t(task.locale, 'global.error'));
    } catch (_) {/* ignore */}
    await updatePaginationControls({ ...task, globalStoriesHasMore: false, globalStoriesState: undefined });
    throw error;
  }
}
