import { jest } from '@jest/globals';

jest.mock('../src/config/env-config', () => ({ BOT_ADMIN_ID: 0, BOT_TOKEN: 't', LOG_FILE: '/tmp/test.log' }));

jest.mock('../src/db', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE invalid_link_violations (
      telegram_id TEXT PRIMARY KEY,
      count INTEGER DEFAULT 0,
      suspended_until INTEGER
    );
  `);
  const recordInvalidLink = (id: string): number => {
    db.prepare(
      `INSERT INTO invalid_link_violations (telegram_id, count)
       VALUES (?, 1)
       ON CONFLICT(telegram_id) DO UPDATE SET count = count + 1`
    ).run(id);
    const row = db.prepare('SELECT count FROM invalid_link_violations WHERE telegram_id = ?').get(id) as any;
    return row.count;
  };
  const suspendUserTemp = (id: string, sec: number) => {
    const until = Math.floor(Date.now() / 1000) + sec;
    db.prepare(
      `INSERT INTO invalid_link_violations (telegram_id, count, suspended_until)
       VALUES (?, 0, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET count = 0, suspended_until = ?`
    ).run(id, until, until);
  };
  const getSuspensionRemaining = (id: string): number => {
    const row = db.prepare('SELECT suspended_until FROM invalid_link_violations WHERE telegram_id = ?').get(id) as any;
    if (!row?.suspended_until) return 0;
    const now = Math.floor(Date.now() / 1000);
    if (row.suspended_until <= now) {
      db.prepare('UPDATE invalid_link_violations SET suspended_until = NULL WHERE telegram_id = ?').run(id);
      return 0;
    }
    return row.suspended_until - now;
  };
  const isUserTemporarilySuspended = (id: string): boolean => getSuspensionRemaining(id) > 0;
  return { db, recordInvalidLink, suspendUserTemp, getSuspensionRemaining, isUserTemporarilySuspended };
});

import { db, recordInvalidLink, suspendUserTemp, isUserTemporarilySuspended, getSuspensionRemaining } from '../src/db';

describe('invalid link suspension utils', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM invalid_link_violations').run();
  });

  test('recordInvalidLink increments count', () => {
    expect(recordInvalidLink('1')).toBe(1);
    expect(recordInvalidLink('1')).toBe(2);
  });

  test('suspendUserTemp stores suspension', () => {
    suspendUserTemp('2', 3600);
    expect(isUserTemporarilySuspended('2')).toBe(true);
    const remain = getSuspensionRemaining('2');
    expect(remain).toBeGreaterThan(0);
  });

  test('suspension expires', () => {
    suspendUserTemp('3', 1);
    db.prepare('UPDATE invalid_link_violations SET suspended_until = ? WHERE telegram_id = ?').run(Math.floor(Date.now() / 1000) - 10, '3');
    expect(isUserTemporarilySuspended('3')).toBe(false);
  });
});
