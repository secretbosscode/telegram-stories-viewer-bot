import { jest } from '@jest/globals';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 999,
}));

jest.mock('../src/db', () => {
  const SyncDatabase = require('../src/db/sqlite-sync').default;
  const db = new SyncDatabase(':memory:');
  db.exec(`
    CREATE TABLE users (
      telegram_id TEXT PRIMARY KEY,
      is_premium INTEGER DEFAULT 0,
      premium_until INTEGER
    );
    CREATE TABLE star_result_bundles (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE download_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      target_username TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      task_details TEXT
    );
  `);
  return { db };
});

import { db } from '../src/db';
import '../src/services/stars-delivery-guard';

describe('Stars delivery queue guards', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM download_queue').run();
    db.prepare('DELETE FROM star_result_bundles').run();
    db.prepare('DELETE FROM users').run();
  });

  test('routes a paid group bundle to its retained group chat', () => {
    db.prepare(
      'INSERT INTO star_result_bundles (id, chat_id, attempt_count) VALUES (?, ?, 0)',
    ).run('group-bundle', '-100123');

    db.prepare(`
      INSERT INTO download_queue (
        telegram_id, target_username, status, task_details
      ) VALUES (?, ?, 'pending', ?)
    `).run(
      '456',
      '@target',
      JSON.stringify({
        chatId: '-100123',
        user: { id: 456 },
        starsBundleId: 'group-bundle',
      }),
    );

    const row = db.prepare(
      'SELECT telegram_id, task_details FROM download_queue LIMIT 1',
    ).get() as any;
    expect(row.telegram_id).toBe('-100123');
    expect(JSON.parse(row.task_details).chatId).toBe('-100123');
  });

  test('restores active Premium entitlement from the group requester ID', () => {
    db.prepare(
      'INSERT INTO users (telegram_id, is_premium, premium_until) VALUES (?, 1, ?)',
    ).run('456', Math.floor(Date.now() / 1000) + 3600);

    db.prepare(`
      INSERT INTO download_queue (
        telegram_id, target_username, status, task_details
      ) VALUES (?, ?, 'pending', ?)
    `).run(
      '-100123',
      '@target',
      JSON.stringify({
        chatId: '-100123',
        user: { id: 456 },
        isPremium: false,
      }),
    );

    const row = db.prepare('SELECT task_details FROM download_queue LIMIT 1').get() as any;
    expect(JSON.parse(row.task_details).isPremium).toBe(1);
  });

  test('restores admin entitlement from the group requester ID', () => {
    db.prepare(`
      INSERT INTO download_queue (
        telegram_id, target_username, status, task_details
      ) VALUES (?, ?, 'pending', ?)
    `).run(
      '-100123',
      '@target',
      JSON.stringify({
        chatId: '-100123',
        user: { id: 999 },
        isPremium: false,
      }),
    );

    const row = db.prepare('SELECT task_details FROM download_queue LIMIT 1').get() as any;
    expect(JSON.parse(row.task_details).isPremium).toBe(1);
  });
});
