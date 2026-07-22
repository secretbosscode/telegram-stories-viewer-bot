import { jest } from '@jest/globals';

jest.mock('../src/db', () => {
  const SyncDatabase = require('../src/db/sqlite-sync').default;
  const db = new SyncDatabase(':memory:');
  db.exec(`
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
        starsBundleId: 'group-bundle',
      }),
    );

    const row = db.prepare(
      'SELECT telegram_id, task_details FROM download_queue LIMIT 1',
    ).get() as any;
    expect(row.telegram_id).toBe('-100123');
    expect(JSON.parse(row.task_details).chatId).toBe('-100123');
  });
});
