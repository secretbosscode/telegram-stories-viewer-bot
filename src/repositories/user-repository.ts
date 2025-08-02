// In: src/repositories/user-repository.ts

import { notifyAdmin } from 'controllers/send-message';
import { db } from 'db';
import { t } from '../lib/i18n';
import type { Telegram } from 'telegraf';
import { User } from 'telegraf/typings/core/types/typegram';
import { createHash } from 'crypto';

// Define a type for our user model that matches the database table.
export interface UserModel {
  telegram_id: string;
  username?: string;
  language?: string;
  is_bot?: number;
  is_premium: 0 | 1; // SQLite stores booleans as 0 or 1
  premium_until?: number | null;
  free_trial_used?: 0 | 1;
  pinned_message_id?: number | null;
  pinned_message_updated_at?: number | null;
  created_at: string;
}

/**
 * saveUser
 * Adds a user to the users table if they do not already exist.
 * Only called when a user sends /start for the first time.
 */
export const saveUser = (user: User) => {
  try {
    const telegramId = user.id.toString();
    const username = user.username || null;
    const isBot = user.is_bot ? 1 : 0;
    const language = user.language_code || null;

    const exists = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(telegramId);

    if (!exists) {
      db.prepare(
        'INSERT INTO users (telegram_id, username, is_bot, language) VALUES (?, ?, ?, ?)'
      ).run(telegramId, username, isBot, language);

      notifyAdmin({
        status: 'info',
        baseInfo: t('en', 'admin.newUserRegistered', {
          user: username ? '@' + username : telegramId,
          id: telegramId,
        }),
      });
    } else {
      db.prepare('UPDATE users SET language = ? WHERE telegram_id = ?').run(
        language,
        telegramId,
      );
    }
  } catch (error) {
    notifyAdmin({
      status: 'error',
      baseInfo: `❌ error occurred adding user to DB:\n${JSON.stringify(error)}`,
    });
    console.log('error on saving user:', error);
  }
};

/**
 * userHasStarted
 * Checks if a user has already been added (has sent /start).
 */
export const userHasStarted = (telegramId: string): boolean => {
  try {
    const exists = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(telegramId);
    return !!exists;
  } catch (error) {
    console.log('error checking user existence:', error);
    return false;
  }
};

// =========================================================================
// NEW FUNCTION ADDED
// This is the function that was missing, causing the build error.
// It retrieves the full user record from the database, including their premium status.
// =========================================================================
export const findUserById = (telegram_id: string): UserModel | undefined => {
  try {
    const stmt = db.prepare('SELECT * FROM users WHERE telegram_id = ?');
    const user = stmt.get(telegram_id) as UserModel | undefined;
    return user;
  } catch (error) {
    console.error(`[DB] Error finding user ${telegram_id}:`, error);
    return undefined;
  }
};

export const refreshUserUsername = async (
  telegram: Telegram,
  user: { telegram_id: string; username?: string | null },
): Promise<string | null | undefined> => {
  try {
    const chat = await telegram.getChat(user.telegram_id);
    const username = (chat as any).username || null;
    if (username !== user.username) {
      db.prepare('UPDATE users SET username = ? WHERE telegram_id = ?').run(
        username,
        user.telegram_id,
      );
      return username;
    }
    return user.username ?? null;
  } catch (error: any) {
    const errMsg = String(error?.description || error?.message || error);
    if (errMsg.includes('chat not found') || errMsg.includes('user not found')) {
      // User removed or no longer accessible
      if (user.username) {
        const hash = createHash('sha256')
          .update(user.username.toLowerCase())
          .digest('hex');
        db.prepare(
          'INSERT OR IGNORE INTO deleted_usernames (username_hash) VALUES (?)',
        ).run(hash);
      }
      db.prepare('DELETE FROM users WHERE telegram_id = ?').run(
        user.telegram_id,
      );
      return undefined;
    }
    console.error(
      `[DB] Error refreshing username for ${user.telegram_id}:`,
      error,
    );
    return user.username ?? null;
  }
};

export const getPinnedMessageId = (telegramId: string): number | undefined => {
  try {
    const row = db
      .prepare('SELECT pinned_message_id FROM users WHERE telegram_id = ?')
      .get(telegramId) as { pinned_message_id?: number } | undefined;
    return row?.pinned_message_id;
  } catch (error) {
    console.error(`[DB] Error getting pinned message id for ${telegramId}:`, error);
    return undefined;
  }
};

export const setPinnedMessageId = (
  telegramId: string,
  messageId: number | null,
): void => {
  try {
    db.prepare('UPDATE users SET pinned_message_id = ? WHERE telegram_id = ?').run(
      messageId,
      telegramId,
    );
  } catch (error) {
    console.error(`[DB] Error setting pinned message id for ${telegramId}:`, error);
  }
};

export const getPinnedMessageUpdatedAt = (
  telegramId: string,
): number | undefined => {
  try {
    const row = db
      .prepare('SELECT pinned_message_updated_at FROM users WHERE telegram_id = ?')
      .get(telegramId) as { pinned_message_updated_at?: number } | undefined;
    return row?.pinned_message_updated_at;
  } catch (error) {
    console.error(`[DB] Error getting pinned message updated_at for ${telegramId}:`, error);
    return undefined;
  }
};

export const setPinnedMessageUpdatedAt = (
  telegramId: string,
  timestamp: number | null,
): void => {
  try {
    db.prepare('UPDATE users SET pinned_message_updated_at = ? WHERE telegram_id = ?').run(
      timestamp,
      telegramId,
    );
  } catch (error) {
    console.error(`[DB] Error setting pinned message updated_at for ${telegramId}:`, error);
  }
};
