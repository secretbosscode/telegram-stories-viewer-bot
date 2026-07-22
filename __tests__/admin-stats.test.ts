import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.STATUS_ID_FILE = '/tmp/admin-status-id';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  BOT_TOKEN: 'token',
  LOG_FILE: '/tmp/test.log',
  BTC_CONFIGURED: false,
}));

jest.mock('../src/db', () => {
  const SyncDatabase = require('../src/db/sqlite-sync').default;
  const db = new SyncDatabase(':memory:');
  db.exec(`
    CREATE TABLE users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT,
      created_at TEXT,
      language TEXT,
      is_premium INTEGER DEFAULT 0,
      premium_until INTEGER
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      invoice_amount REAL,
      user_address TEXT,
      paid_amount REAL DEFAULT 0,
      expires_at INTEGER,
      paid_at INTEGER
    );
    CREATE TABLE payment_checks (
      invoice_id INTEGER PRIMARY KEY,
      next_check INTEGER NOT NULL,
      check_start INTEGER NOT NULL
    );
    CREATE TABLE referrals (created_at INTEGER);
    CREATE TABLE download_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT,
      target_username TEXT,
      status TEXT,
      enqueued_ts INTEGER,
      task_details TEXT
    );
    CREATE TABLE monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      target_id TEXT,
      target_username TEXT,
      target_access_hash TEXT,
      last_checked INTEGER,
      last_photo_id TEXT,
      created_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_request_log (
      telegram_id TEXT NOT NULL,
      requested_at INTEGER NOT NULL
    );
  `);
  return { db };
});

import fs from 'fs';
import { sendStartupStatus, updateAdminStatus } from '../src/services/admin-stats';

const telegram: any = {
  sendMessage: jest.fn(() => Promise.resolve({ message_id: 1 })),
  pinChatMessage: jest.fn(),
  editMessageText: jest.fn(),
  unpinChatMessage: jest.fn(() => Promise.resolve()),
};
const bot: any = { telegram };

describe('admin stats status message', () => {
  beforeEach(() => {
    telegram.sendMessage.mockClear();
    telegram.pinChatMessage.mockClear();
    telegram.editMessageText.mockClear();
    telegram.unpinChatMessage.mockClear();
    fs.writeFileSync('/tmp/test.log', '');
    try {
      fs.unlinkSync('/tmp/admin-status-id');
    } catch {}
  });

  test('sends startup status with uptime and pins message', async () => {
    fs.writeFileSync('/tmp/admin-status-id', '9');
    await sendStartupStatus(bot);
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      0,
      expect.stringContaining('Uptime: 0h 0m'),
    );
    const text = telegram.sendMessage.mock.calls[0][1];
    expect(text).toContain('Queue:');
    expect(telegram.unpinChatMessage).toHaveBeenCalledWith(0, 9);
    expect(telegram.pinChatMessage).toHaveBeenCalledWith(0, 1, {
      disable_notification: true,
    });
  });

  test('updates status message', async () => {
    await sendStartupStatus(bot);
    telegram.editMessageText.mockClear();
    await updateAdminStatus(bot);
    expect(telegram.editMessageText).toHaveBeenCalledWith(
      0,
      1,
      undefined,
      expect.stringContaining('Uptime:'),
    );
    const text = telegram.editMessageText.mock.calls[0][3];
    expect(text).toContain('Queue:');
  });
});
