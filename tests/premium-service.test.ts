import { Database } from 'better-sqlite3';

// Mock the db module used by premium-service
jest.mock('../src/db', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY NOT NULL,
      username TEXT,
      is_premium INTEGER DEFAULT 0,
      premium_until INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return { db };
});

import { db } from '../src/db';
import {
  isUserPremium,
  addPremiumUser,
  removePremiumUser,
  getPremiumDaysLeft
} from '../src/services/premium-service';

beforeEach(() => {
  db.exec('DELETE FROM users');
});

describe('premium-service', () => {
  test('addPremiumUser marks user as premium', () => {
    addPremiumUser('1', 'test', 10);
    expect(isUserPremium('1')).toBe(true);
  });

  test('removePremiumUser clears premium status', () => {
    addPremiumUser('2', 'user');
    removePremiumUser('2');
    expect(isUserPremium('2')).toBe(false);
  });

  test('getPremiumDaysLeft returns remaining days', () => {
    const now = Date.now();
    jest.useFakeTimers().setSystemTime(now);
    addPremiumUser('3', 'user', 5);
    expect(getPremiumDaysLeft('3')).toBe(5);
    // advance 3 days
    jest.setSystemTime(now + 3 * 86400 * 1000);
    expect(getPremiumDaysLeft('3')).toBe(2);
    jest.useRealTimers();
  });
});
