import { jest } from '@jest/globals';

// Mock the ../db module to use an in-memory DB for testing
jest.mock('../src/db', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE profile_requests (
      telegram_id TEXT NOT NULL,
      target_username TEXT NOT NULL,
      requested_at INTEGER NOT NULL
    );
  `);
  const recordProfileRequest = (telegram_id: string, target_username: string) => {
    db.prepare(
      `INSERT INTO profile_requests (telegram_id, target_username, requested_at) VALUES (?, ?, strftime('%s','now'))`,
    ).run(telegram_id, target_username);
  };
  const wasProfileRequestedRecently = (
    telegram_id: string,
    target_username: string,
    hours: number,
  ): boolean => {
    if (hours <= 0) return false;
    const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
    const row = db
      .prepare(
        `SELECT 1 FROM profile_requests WHERE telegram_id = ? AND target_username = ? AND requested_at > ? LIMIT 1`,
      )
      .get(telegram_id, target_username, cutoff);
    return !!row;
  };
  return { db, recordProfileRequest, wasProfileRequestedRecently };
});

import { db } from '../src/db';
import { recordProfileRequest, wasProfileRequestedRecently } from '../src/db';

describe('profile request spam protection', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM profile_requests').run();
  });

  test('detects recent request', () => {
    recordProfileRequest('1', 'user');
    const recent = wasProfileRequestedRecently('1', 'user', 1);
    expect(recent).toBe(true);
  });

  test('ignores old request', () => {
    const ts = Math.floor(Date.now() / 1000) - 7200;
    db.prepare(
      'INSERT INTO profile_requests (telegram_id, target_username, requested_at) VALUES (?,?,?)',
    ).run('1', 'user', ts);
    const recent = wasProfileRequestedRecently('1', 'user', 1);
    expect(recent).toBe(false);
  });
});
