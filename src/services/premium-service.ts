import { db } from '../db'; // Adjust if your db import path is different

export const isUserPremium = (telegramId: string): boolean => {
  const row = db
    .prepare('SELECT is_premium FROM users WHERE telegram_id = ?')
    .get(telegramId);
  return !!(row && row.is_premium);
};

export const addPremiumUser = (telegramId: string, username?: string): void => {
  db.prepare(
    `INSERT INTO users (telegram_id, username, is_premium)
     VALUES (?, ?, 1)
     ON CONFLICT(telegram_id) DO UPDATE SET is_premium = 1`
  ).run(telegramId, username || null);
};
