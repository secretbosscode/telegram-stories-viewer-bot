import { notifyAdmin } from 'controllers/send-message';
import { db } from 'db'; // Adjust the import path if needed
import { User } from 'telegraf/typings/core/types/typegram';

// Save user to DB if not already present
export const saveUser = (user: User) => {
  try {
    const telegramId = user.id.toString();
    const username = user.username || null;

    // Check if the user already exists
    const exists = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(telegramId);
    if (!exists) {
      db.prepare(
        'INSERT INTO users (telegram_id, username) VALUES (?, ?)'
      ).run(telegramId, username);

      notifyAdmin({
        status: 'info',
        baseInfo: `👤 New user added to DB`,
      });
    }
  } catch (error) {
    notifyAdmin({
      status: 'error',
      baseInfo: `❌ error occurred adding user to DB:\n${JSON.stringify(error)}`,
    });
    console.log('error on saving user:', error);
  }
};
