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

// Users Table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY NOT NULL,
    username TEXT,
    is_premium INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

// Download Queue Table
db.exec(`
  CREATE TABLE IF NOT EXISTS download_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    target_username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, done, error
    enqueued_ts INTEGER NOT NULL,
    processed_ts INTEGER,
    error TEXT,
    UNIQUE(telegram_id, target_username, status) ON CONFLICT IGNORE
  );
`);

// ===== DB UTILS =====

export function enqueueDownload(telegram_id: string, target_username: string) {
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(`
      INSERT INTO download_queue (telegram_id, target_username, enqueued_ts, status)
      VALUES (?, ?, ?, 'pending')
    `).run(telegram_id, target_username, now);
    return true;
  } catch {
    return false;
  }
}

export function getNextQueueItem() {
  // Prioritize admin, then premium, then free
  const row = db.prepare(`
    SELECT q.*, u.is_premium
    FROM download_queue q
    LEFT JOIN users u ON u.telegram_id = q.telegram_id
    WHERE q.status = 'pending'
    ORDER BY 
      CASE WHEN q.telegram_id = ? THEN 0 ELSE 1 END,  -- admin first
      u.is_premium DESC, 
      q.enqueued_ts ASC
    LIMIT 1
  `).get(process.env.BOT_ADMIN_ID || '');
  return row;
}

export function markProcessing(id: number) {
  db.prepare(`UPDATE download_queue SET status = 'processing' WHERE id = ?`).run(id);
}
export function markDone(id: number) {
  db.prepare(`UPDATE download_queue SET status = 'done', processed_ts = ? WHERE id = ?`).run(Math.floor(Date.now() / 1000), id);
}
export function markError(id: number, error: string) {
  db.prepare(`UPDATE download_queue SET status = 'error', error = ?, processed_ts = ? WHERE id = ?`).run(error, Math.floor(Date.now() / 1000), id);
}
export function cleanupQueue() {
  // Remove all but the last 50 per user, or anything older than 3 days
  db.prepare(`
    DELETE FROM download_queue 
    WHERE id IN (
      SELECT id FROM download_queue
      WHERE processed_ts IS NOT NULL AND processed_ts < (strftime('%s','now') - 259200)
    )
  `).run();
}

export function wasRecentlyDownloaded(telegram_id: string, target_username: string, hours: number) {
  if (hours <= 0) return false;
  const cutoff = Math.floor(Date.now() / 1000) - (hours * 3600);
  const row = db.prepare(`
    SELECT id FROM download_queue
    WHERE telegram_id = ? AND target_username = ? 
      AND status = 'done' AND processed_ts > ?
    ORDER BY processed_ts DESC LIMIT 1
  `).get(telegram_id, target_username, cutoff);
  return !!row;
}

export function isDuplicatePending(telegram_id: string, target_username: string) {
  // Prevents same user/target combo being in queue at once
  const row = db.prepare(`
    SELECT id FROM download_queue 
    WHERE telegram_id = ? AND target_username = ? 
      AND (status = 'pending' OR status = 'processing')
    LIMIT 1
  `).get(telegram_id, target_username);
  return !!row;
}
