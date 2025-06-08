import { db } from '../db';

export interface UserRow {
  telegram_id?: string;
  username?: string;
  is_premium?: number;
  premium_until?: number | null;
}

/**
 * Checks if a user is premium by Telegram ID.
 * @param telegramId Telegram user ID as a string.
 * @returns true if premium, false otherwise.
 */
export const isUserPremium = (telegramId: string): boolean => {
  const row = db
    .prepare('SELECT is_premium, premium_until FROM users WHERE telegram_id = ?')
    .get(telegramId) as UserRow | undefined;

  if (!row) return false;

  if (row.premium_until && row.premium_until < Math.floor(Date.now() / 1000)) {
    // Expired - reset
    db.prepare('UPDATE users SET is_premium = 0 WHERE telegram_id = ?').run(telegramId);
    return false;
  }
  return !!row.is_premium;
};

/**
 * Marks a user as premium (creates user if missing).
 * @param telegramId Telegram user ID.
 * @param username (optional) Telegram username.
 */
export const addPremiumUser = (telegramId: string, username?: string, days?: number): void => {
  const expires = days ? Math.floor(Date.now() / 1000) + days * 86400 : null;
  if (username) {
    db.prepare(
      `INSERT INTO users (telegram_id, username, is_premium, premium_until)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET is_premium = 1, username = excluded.username, premium_until = ?`
    ).run(telegramId, username, expires, expires);
  } else {
    db.prepare(
      `INSERT INTO users (telegram_id, is_premium, premium_until)
       VALUES (?, 1, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET is_premium = 1, premium_until = ?`
    ).run(telegramId, expires, expires);
  }
};

/**
 * Removes premium status from a user.
 * @param telegramId Telegram user ID.
 */
export const removePremiumUser = (telegramId: string): void => {
  db.prepare(
    `UPDATE users SET is_premium = 0, premium_until = NULL WHERE telegram_id = ?`
  ).run(telegramId);
};

export const extendPremium = (telegramId: string, days: number): void => {
  const until = Math.floor(Date.now() / 1000) + days * 86400;
  db.prepare(
    `UPDATE users SET is_premium = 1, premium_until = ? WHERE telegram_id = ?`
  ).run(until, telegramId);
};

export const getPremiumDaysLeft = (telegramId: string): number => {
  const row = db
    .prepare('SELECT premium_until FROM users WHERE telegram_id = ?')
    .get(telegramId) as UserRow | undefined;

  if (!row || !row.premium_until) return Infinity;

  const secondsLeft = row.premium_until - Math.floor(Date.now() / 1000);
  if (secondsLeft <= 0) return 0;
  return Math.ceil(secondsLeft / 86400);
};

