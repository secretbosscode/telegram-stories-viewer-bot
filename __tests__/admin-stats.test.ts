import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.STATUS_ID_FILE = '/tmp/admin-status-id';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  BOT_TOKEN: 'token',
  LOG_FILE: '/tmp/test.log',
}));

jest.mock('../src/db', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (created_at TEXT);
    CREATE TABLE payments (paid_at INTEGER);
    CREATE TABLE referrals (created_at INTEGER);
    CREATE TABLE download_queue (status TEXT);
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
