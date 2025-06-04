import { db } from '../db'; // Adjust the import path if your DB logic is elsewhere

export const isUserPremium = (userId: number): boolean => {
  const row = db
    .prepare('SELECT is_premium FROM users WHERE id = ?')
    .get(userId);
  return !!(row && row.is_premium);
};

export const addPremiumUser = (userId: number): void => {
  db.prepare(
    `INSERT INTO users (id, is_premium) 
     VALUES (?, 1) 
     ON CONFLICT(id) DO UPDATE SET is_premium = 1`
  ).run(userId);
};
