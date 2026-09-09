import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// A database created by an older release, where monitors.target_username was
// declared NOT NULL. The current code must be able to store a removed username
// (null) on such an install, so the schema is relaxed on startup.
const dir = path.join(process.env.TEST_DATA_DIR || '/data', 'legacy-monitors-schema');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.TEST_DATA_DIR = dir;

const legacy = new Database(path.join(dir, 'database.db'));
legacy.exec(`
  CREATE TABLE monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    target_username TEXT NOT NULL,
    last_checked INTEGER,
    last_photo_id TEXT,
    target_id TEXT,
    target_access_hash TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE UNIQUE INDEX monitor_unique_idx ON monitors (telegram_id, target_id);
  INSERT INTO monitors (telegram_id, target_username, target_id, target_access_hash, last_photo_id)
    VALUES ('legacy-user', 'oldhandle', '4242', '99', 'photo-1');
`);
legacy.close();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../src/db') as typeof import('../src/db');

afterAll(() => {
  db.closeDatabase();
});

test('a legacy NOT NULL on monitors.target_username is dropped without losing rows', () => {
  const info = db.db.prepare('PRAGMA table_info(monitors)').all() as any[];
  const column = info.find((c) => c.name === 'target_username');
  expect(Number(column.notnull)).toBe(0);

  const row = db.listMonitors('legacy-user')[0];
  expect(row).toBeDefined();
  expect(row.target_username).toBe('oldhandle');
  expect(row.target_access_hash).toBe('99');
  expect(row.last_photo_id).toBe('photo-1');

  db.updateMonitorUsername(row.id, null);
  expect(db.getMonitor(row.id)!.target_username).toBeNull();
});

test('the unique (telegram_id, target_id) index survives the rebuild', () => {
  const indexes = db.db.prepare('PRAGMA index_list(monitors)').all() as any[];
  expect(indexes.some((i) => i.name === 'monitor_unique_idx' && Number(i.unique) === 1)).toBe(true);
  db.addMonitor('legacy-user', '4242', 'again', '99');
  expect(db.listMonitors('legacy-user').filter((m) => m.target_id === '4242')).toHaveLength(1);
});
