import { db } from '../db';

interface UserRow {
  is_premium?: number;
}

/** Returns true if user is premium, false otherwise */
export const isUserPremium = (telegramId: string): boolean => {
  const row = db
    .prepare('SELECT is_premium FROM users WHERE telegram_id = ?')
    .get(telegramId) as UserRow | undefined;

  return !!row?.is_premium;
};

/** Sets user as premium, updates username if provided, creates user if missing */
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

/** Optionally, for downgrade/removal: */
export const removePremiumUser = (telegramId: string): void => {
  db.prepare(
    `UPDATE users SET is_premium = 0 WHERE telegram_id = ?`
  ).run(telegramId);
};
