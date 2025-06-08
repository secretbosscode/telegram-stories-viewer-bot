import {
  addPremiumUser,
  isUserPremium,
  removePremiumUser,
  getPremiumDaysLeft,
  grantFreeTrial,
  hasUsedFreeTrial,
} from '../src/services/premium-service';

// Mock the ../db module used by premium-service to use an in-memory DB
jest.mock('../src/db', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      telegram_id TEXT PRIMARY KEY NOT NULL,
      username TEXT,
      is_bot INTEGER DEFAULT 0,
      is_premium INTEGER DEFAULT 0,
      free_trial_used INTEGER DEFAULT 0,
      premium_until INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return { db };
});

// After mocking, import again to ensure db is initialized
import { db } from '../src/db';

describe('premium-service', () => {
  beforeEach(() => {
    // Clean users table before each test
    db.prepare('DELETE FROM users').run();
  });

  test('addPremiumUser marks user premium with expiration', () => {
    addPremiumUser('1', 'test', 1); // 1 day
    const row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get('1') as any;
    expect(row.is_premium).toBe(1);
    expect(row.username).toBe('test');
    expect(row.premium_until).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('isUserPremium returns true only when premium not expired', () => {
    addPremiumUser('2', 'user');
    expect(isUserPremium('2')).toBe(true);
    removePremiumUser('2');
    expect(isUserPremium('2')).toBe(false);
  });

  test('removePremiumUser clears premium info', () => {
    addPremiumUser('3', 'user', 2);
    removePremiumUser('3');
    const row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get('3') as any;
    expect(row.is_premium).toBe(0);
    expect(row.premium_until).toBeNull();
  });

  test('getPremiumDaysLeft calculates remaining days', () => {
    addPremiumUser('4', 'user', 2);
    const daysLeft = getPremiumDaysLeft('4');
    expect(daysLeft).toBeGreaterThanOrEqual(1);
    expect(daysLeft).toBeLessThanOrEqual(2);
  });

  test('grantFreeTrial sets premium and marks trial used', () => {
    grantFreeTrial('5');
    const row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get('5') as any;
    expect(row.is_premium).toBe(1);
    expect(row.free_trial_used).toBe(1);
    expect(hasUsedFreeTrial('5')).toBe(true);
  });
});
