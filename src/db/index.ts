// index.ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(__dirname, '../../data/database.db');

// Ensure /data folder exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new Database(DB_PATH);

// Initialize users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY NOT NULL,
    username TEXT,
    is_premium INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

// Persistent download queue table
db.exec(`
  CREATE TABLE IF NOT EXISTS download_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    target_username TEXT NOT NULL,
    status TEXT DEFAULT 'pending',         -- 'pending', 'processing', 'done', 'error'
    enqueued_ts INTEGER NOT NULL,          -- UNIX timestamp
    processed_ts INTEGER,                  -- UNIX timestamp
    error_msg TEXT,
    UNIQUE(telegram_id, target_username, status) -- Prevent duplicate queue entries per status
  );
`);

// Add a function to enqueue downloads
export function enqueueDownload(telegram_id: string, target_username: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(`
      INSERT INTO download_queue (telegram_id, target_username, status, enqueued_ts)
      VALUES (?, ?, 'pending', ?)
    `).run(telegram_id, target_username, now);
    return true;
  } catch (e) {
    // Likely a unique constraint violation
    return false;
  }
}

// Get next item in queue (to process)
export function getNextQueueItem() {
  return db.prepare(`
    SELECT * FROM download_queue WHERE status = 'pending' ORDER BY enqueued_ts LIMIT 1
  `).get();
}

// Mark queue item as processing
export function markProcessing(id: number) {
  db.prepare(`
    UPDATE download_queue SET status = 'processing' WHERE id = ?
  `).run(id);
}

// Mark queue item as done (and record completion timestamp)
export function markDone(id: number) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE download_queue SET status = 'done', processed_ts = ? WHERE id = ?
  `).run(now, id);
}

// Mark queue item as error with message
export function markError(id: number, errorMsg: string) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE download_queue SET status = 'error', processed_ts = ?, error_msg = ?
    WHERE id = ?
  `).run(now, errorMsg, id);
}

// Clean up old 'done' or 'error' items (default: keep last 24h)
export function cleanupQueue(hoursToKeep: number = 24) {
  const cutoff = Math.floor(Date.now() / 1000) - hoursToKeep * 3600;
  db.prepare(`
    DELETE FROM download_queue
    WHERE (status = 'done' OR status = 'error') AND processed_ts IS NOT NULL AND processed_ts < ?
  `).run(cutoff);
}

// Optionally: Run this cleanup on server start or periodically (e.g., every hour)
cleanupQueue();

export default db;
