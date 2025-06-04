import { db } from '../db';

interface UserRow {
  is_premium?: number;
}

export const isUserPremium = (telegramId: string): boolean => {
  const row = db
    .prepare('SELECT is_premium FROM users WHERE telegram_id = ?')
    .get(telegramId) as UserRow | undefined;

  return Boolean(row?.is_premium);
};

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
