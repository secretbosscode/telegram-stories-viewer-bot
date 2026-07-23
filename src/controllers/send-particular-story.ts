// src/controllers/send-particular-story.ts

import { bot } from 'index';
import { t } from 'lib/i18n';
import { sendTemporaryMessage } from 'lib';
import { SendParticularStoryArgs, MappedStoryItem, NotifyAdminParams } from 'types';
import { downloadStories, mapStories } from 'controllers/download-stories';
import { notifyAdmin } from 'controllers/send-message';

/**
 * Sends a particular story and returns its ID only after Telegram confirms
 * media delivery. Paid Stars bundles use the returned IDs as fulfillment proof.
 */
export async function sendParticularStory({
  story,
  task,
}: SendParticularStoryArgs): Promise<number[]> {
  const mapped: MappedStoryItem[] = mapStories([story]);

  try {
    await sendTemporaryMessage(
      bot,
      task.chatId,
      t(task.locale, 'download.downloading'),
    ).catch((error) => {
      console.error(
        `[sendParticularStory] Failed to send 'Downloading' message to ${task.chatId}:`,
        error,
      );
    });

    await downloadStories(mapped, 'active');
    const singleStory = mapped[0];

    if (!singleStory?.buffer) {
      await bot.telegram
        .sendMessage(task.chatId, t(task.locale, 'download.noStory'))
        .catch((error) => {
          console.error(
            `[sendParticularStory] Failed to notify ${task.chatId} about retrieval error:`,
            error,
          );
        });
      return [];
    }

    await sendTemporaryMessage(
      bot,
      task.chatId,
      t(task.locale, 'download.uploading'),
    ).catch((error) => {
      console.error(
        `[sendParticularStory] Failed to send 'Uploading' message to ${task.chatId}:`,
        error,
      );
    });

    const media = { source: singleStory.buffer };
    const extra = {
      caption: (
        `${singleStory.caption ? `${singleStory.caption}\n` : ''}` +
        `\n📅 Post date: ${singleStory.date.toUTCString()}`
      ).slice(0, 1024),
    };

    if (singleStory.mediaType === 'photo') {
      await bot.telegram.sendPhoto(task.chatId, media, extra);
    } else {
      await bot.telegram.sendVideo(task.chatId, media, extra);
    }

    notifyAdmin({
      task,
      status: 'info',
      baseInfo: '📥 Particular story uploaded to user!',
    } as NotifyAdminParams);

    return [singleStory.id];
  } catch (error) {
    notifyAdmin({
      status: 'error',
      task,
      errorInfo: { cause: error },
    } as NotifyAdminParams);
    console.error('[sendParticularStory] Error occurred while sending story:', error);
    await bot.telegram
      .sendMessage(task.chatId, t(task.locale, 'pinned.error'))
      .catch((notifyError) => {
        console.error(
          `[sendParticularStory] Failed to notify ${task.chatId} about general error:`,
          notifyError,
        );
      });
    throw error;
  }
}
