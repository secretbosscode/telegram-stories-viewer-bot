import { notifyAdmin } from 'controllers/send-message';
import { db } from 'db'; // Adjust the import path if needed

export const saveUser = (user) => {
  try {
    // Check if the user already exists
    const exists = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(user.id.toString());
    if (!exists) {
      db.prepare(
        'INSERT INTO users (telegram_id, username) VALUES (?, ?)'
      ).run(user.id.toString(), user.username || null);

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
