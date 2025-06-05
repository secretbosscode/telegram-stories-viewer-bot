import { db } from '../db';

export interface UserRow {
  telegram_id?: string;
  username?: string;
  is_premium?: number;
}

/**
 * Checks if a user is premium by Telegram ID.
 * @param telegramId Telegram user ID as a string.
 * @returns true if premium, false otherwise.
 */
export const isUserPremium = (telegramId: string): boolean => {
  const row = db
    .prepare('SELECT is_premium FROM users WHERE telegram_id = ?')
    .get(telegramId) as UserRow | undefined;

  return !!row?.is_premium;
};

/**
 * Marks a user as premium (creates user if missing).
 * @param telegramId Telegram user ID.
 * @param username (optional) Telegram username.
 */
export const addPremiumUser = (telegramId: string, username?: string): void => {
  if (username) {
    db.prepare(
      `INSERT INTO users (telegram_id, username, is_premium)
       VALUES (?, ?, 1)
       ON CONFLICT(telegram_id) DO UPDATE SET is_premium = 1, username = excluded.username`
    ).run(telegramId, username);
  } else {
    db.prepare(
      `INSERT INTO users (telegram_id, is_premium)
       VALUES (?, 1)
       ON CONFLICT(telegram_id) DO UPDATE SET is_premium = 1`
    ).run(telegramId);
  }
};

/**
 * Removes premium status from a user.
 * @param telegramId Telegram user ID.
 */
export const removePremiumUser = (telegramId: string): void => {
  db.prepare(
    `UPDATE users SET is_premium = 0 WHERE telegram_id = ?`
  ).run(telegramId);
};
