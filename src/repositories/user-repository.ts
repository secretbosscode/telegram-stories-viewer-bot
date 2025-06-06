// ===============================
//   User Repository - DB Logic
//   Handles: DB insert/check for bot users
// ===============================

import { notifyAdmin } from 'controllers/send-message';
import { db } from 'db'; // Do not change this unless your DB path changes
import { User } from 'telegraf/typings/core/types/typegram';

/**
 * saveUser
 * Adds a user to the users table if they do not already exist.
 * Only called when a user sends /start for the first time.
 * @param user - Telegram User object
 */
export const saveUser = (user: User) => {
  try {
    const telegramId = user.id.toString();
    const username = user.username || null;

    // Check if the user already exists in the database
    const exists = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(telegramId);

    if (!exists) {
      // Add new user to DB
      db.prepare(
        'INSERT INTO users (telegram_id, username) VALUES (?, ?)'
      ).run(telegramId, username);

      // Notify admin for logging/monitoring
      notifyAdmin({
        status: 'info',
        baseInfo: `👤 New user added to DB`,
      });
    }
  } catch (error) {
    // Error logging and admin notification
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
 * @param telegramId - Telegram user ID (as string)
 * @returns boolean - true if exists, false if not
 */
export const userHasStarted = (telegramId: string): boolean => {
  try {
    const exists = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(telegramId);
    return !!exists;
  } catch (error) {
    console.log('error checking user existence:', error);
    return false; // safest default: treat as not started
  }
};
