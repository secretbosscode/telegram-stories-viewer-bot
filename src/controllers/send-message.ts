import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
// Make sure to import UserInfo from your new location, e.g.:
import { UserInfo } from '../db/types'; // update path as needed

/**
 * Notify the bot admin of important events (errors, info, start).
 * Skips notification if admin triggers their own task.
 */
export async function notifyAdmin({
  task,
  status,
  errorInfo,
  baseInfo,
}: {
  task?: UserInfo;
  status: 'start' | 'error' | 'info';
  errorInfo?: { cause: unknown };
  baseInfo?: string;
}) {
  if (task?.chatId === BOT_ADMIN_ID.toString()) return;

  // Build user info for logs/messages
  const userInfo = JSON.stringify(
    { ...(task?.user ?? {}), username: '@' + (task?.user?.username || '') },
    null,
    2
  );
  const msgOptions = { link_preview_options: { is_disabled: true } };

  try {
    if (status === 'error' && errorInfo) {
      await bot.telegram.sendMessage(
        BOT_ADMIN_ID,
        '🛑 ERROR 🛑\n' +
          `🔗 Target link: ${task?.link}\n` +
          `reason: ${JSON.stringify(errorInfo.cause)}\n` +
          `author: ${userInfo}`,
        msgOptions
      );
      return;
    }

    if (status === 'info' && baseInfo) {
      let text = baseInfo;
      if (task?.user) {
        text += '\n👤 user: ' + userInfo;
      }
      await bot.telegram.sendMessage(BOT_ADMIN_ID, text, msgOptions);
      return;
    }

    if (status === 'start') {
      await bot.telegram.sendMessage(BOT_ADMIN_ID, `👤 Task started by: ${userInfo}`, {
        ...msgOptions,
        parse_mode: 'HTML',
      });
    }
  } catch (e) {
    // Avoid throwing in the background
    console.error('[notifyAdmin] Failed to send admin notification:', e);
  }
}

/**
 * Sends a message to the user and notifies admin of the error.
 * Used for operational errors and feedback.
 */
export async function sendErrorMessage({
  task,
  message,
}: {
  task: UserInfo;
  message: string;
}) {
  console.log('[sendErrorMessage] error occurred:', message);
  await notifyAdmin({
    task,
    status: 'error',
    errorInfo: { cause: message },
  });
  try {
    await bot.telegram.sendMessage(task.chatId, message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    // If bot fails to send, just log it
    console.error('[sendErrorMessage] failed to send error message to user:', e);
  }
}
