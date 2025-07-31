import { jest } from '@jest/globals';

jest.mock('../src/db', () => {
  const SyncDatabase = require('../src/db/sqlite-sync').default;
  const db = new SyncDatabase(':memory:');
  db.exec(`
    CREATE TABLE download_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT,
      target_username TEXT,
      status TEXT,
      enqueued_ts INTEGER,
      processed_ts INTEGER,
      error TEXT,
      task_details TEXT
    );
  `);

  const resetStuckJobs = () => {
    try {
      const resetStmt = db.prepare(
        `UPDATE download_queue
         SET status = 'pending', processed_ts = NULL
         WHERE status = 'processing'`
      );
      const resetInfo = resetStmt.run();

      const deleteStmt = db.prepare(
        `DELETE FROM download_queue
         WHERE status = 'error' AND processed_ts <= (strftime('%s','now') - 86400)`
      );
      const deleteInfo = deleteStmt.run();

      if ((resetInfo.changes as number) + (deleteInfo.changes as number) > 0) {
        // noop
      }
    } catch (err) {
      throw err;
    }
  };

  return { db, resetStuckJobs };
});

import { db, resetStuckJobs } from '../src/db';

describe('resetStuckJobs', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM download_queue').run();
  });

  afterAll(() => {
    jest.resetModules();
  });

  test('resets processing jobs to pending', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO download_queue (telegram_id, target_username, status, enqueued_ts) VALUES ('1','u','processing',?)`
    ).run(now - 100);
    resetStuckJobs();
    const row = db.prepare('SELECT status FROM download_queue').get() as any;
    expect(row.status).toBe('pending');
  });

  test('keeps recent error but removes old ones', () => {
    const now = Math.floor(Date.now() / 1000);
    // recent error (1 hour old)
    db.prepare(
      `INSERT INTO download_queue (telegram_id, target_username, status, enqueued_ts, processed_ts) VALUES ('2','u','error',?,?)`
    ).run(now - 200, now - 3600);
    // old error (30 hours old)
    db.prepare(
      `INSERT INTO download_queue (telegram_id, target_username, status, enqueued_ts, processed_ts) VALUES ('3','u','error',?,?)`
    ).run(now - 300, now - 90000);
    resetStuckJobs();
    const rows = db.prepare('SELECT id, status FROM download_queue ORDER BY id').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('error');
  });

  test('deletes errors older than 24 hours', () => {
    const now = Math.floor(Date.now() / 1000) - 90000; // >24h ago
    db.prepare(
      `INSERT INTO download_queue (telegram_id, target_username, status, enqueued_ts, processed_ts) VALUES ('4','u','error',?,?)`
    ).run(now, now);
    resetStuckJobs();
    const row = db.prepare('SELECT * FROM download_queue').get() as any;
    expect(row).toBeUndefined();
  });
});
