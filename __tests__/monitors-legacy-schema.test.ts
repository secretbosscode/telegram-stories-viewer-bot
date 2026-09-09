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
  -- Deleted rows leave the AUTOINCREMENT high-water mark above the live max.
  INSERT INTO monitors (telegram_id, target_username, target_id) VALUES ('legacy-user', 'gone1', '1');
  INSERT INTO monitors (telegram_id, target_username, target_id) VALUES ('legacy-user', 'gone2', '2');
  DELETE FROM monitors WHERE target_id IN ('1', '2');
  -- Persisted Stars-safety style triggers: one on monitors itself, and one on
  -- another table whose body references monitors (this one made the rename
  -- fail before dependents were dropped around the rebuild).
  CREATE TABLE star_payments_like (id INTEGER PRIMARY KEY, note TEXT);
  CREATE TRIGGER legacy_on_monitors BEFORE DELETE ON monitors
  BEGIN
    SELECT 1;
  END;
  CREATE TRIGGER legacy_refers_to_monitors AFTER INSERT ON star_payments_like
  BEGIN
    DELETE FROM monitors WHERE id = -1;
  END;
`);
const legacySeq = (legacy.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'monitors'`).get() as any).seq;
const legacyTriggers = legacy
  .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
  .all() as { name: string; sql: string }[];
legacy.close();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../src/db') as typeof import('../src/db');
// Captured before any test inserts: an attempted (even ignored) insert into an
// AUTOINCREMENT table advances sqlite_sequence.
const migratedSeq = Number(
  (db.db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'monitors'`).get() as any).seq,
);

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

test('dependent triggers are recreated verbatim and the id high-water mark is preserved', () => {
  const triggers = db.db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
    .all() as { name: string; sql: string }[];
  expect(triggers.map((t) => t.name)).toEqual(legacyTriggers.map((t) => t.name));
  expect(triggers.map((t) => t.sql)).toEqual(legacyTriggers.map((t) => t.sql));

  expect(legacySeq).toBe(3);
  expect(migratedSeq).toBe(3); // not reset to the live max (1)
  const fresh = db.addMonitor('legacy-user', '5', 'fresh', null);
  expect(fresh.id).toBeGreaterThan(3); // never reuses the deleted ids 2 and 3
});
