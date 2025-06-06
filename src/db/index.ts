// src/db/index.ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DownloadQueueItem, UserInfo } from 'types'; // Import necessary types

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

export function enqueueDownload(telegram_id: string, target_username: string): boolean {
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

// Corrected return type and mapped properties from DB row to DownloadQueueItem
export function getNextQueueItem(): DownloadQueueItem | null {
  const row: any = db.prepare(`
    SELECT q.*, u.is_premium
    FROM download_queue q
    LEFT JOIN users u ON u.telegram_id = q.telegram_id
    WHERE q.status = 'pending'
    ORDER BY
      CASE WHEN q.telegram_id = ? THEN 0 ELSE 1 END,
      u.is_premium DESC,
      q.enqueued_ts ASC
    LIMIT 1
  `).get(process.env.BOT_ADMIN_ID || '');

  // Map the raw database row to the DownloadQueueItem interface
  if (row) {
    return {
      id: row.id.toString(), // Convert number ID from DB to string as per DownloadQueueItem interface
      chatId: row.telegram_id, // Map telegram_id from DB to chatId in interface
      task: { // Create UserInfo object for the task property
        chatId: row.telegram_id,
        link: row.target_username,
        linkType: 'username', // Default or infer if possible
        locale: 'en', // Default or get from user table if stored
        user: undefined, // No user object from this query
        initTime: row.enqueued_ts * 1000, // Convert seconds to milliseconds
        isPremium: row.is_premium === 1, // Convert INTEGER 0/1 to boolean
        // storyRequestType will need to be added if loaded from DB or assigned later
      },
      status: row.status as 'pending' | 'in_progress' | 'done' | 'error', // Cast DB string to union type
      enqueued_ts: row.enqueued_ts,
      processed_ts: row.processed_ts,
      error: row.error,
      is_premium: row.is_premium // Keep this directly if DB provides it
    };
  }
  return null;
}

// Corrected parameter type for id from number to string, AND FIXED UNTERMINATED LITERAL
export function markProcessing(id: string): void {
  db.prepare(`UPDATE download_queue SET status = 'processing' WHERE id = ?`).run(id);
}
// Corrected parameter type for id from number to string
export function markDone(id: string): void {
  db.prepare(`UPDATE download_queue SET status = 'done', processed_ts = ? WHERE id = ?`).run(Math.floor(Date.now() / 1000), id);
}
// Corrected parameter type for id from number to string
export function markError(id: string, error: string): void {
  db.prepare(`UPDATE download_queue SET status = 'error', error = ?, processed_ts = ? WHERE id = ?`).run(error, Math.floor(Date.now() / 1000), id);
}
export function cleanupQueue(): void {
  // Remove all but the last 50 per user, or anything older than 3 days
  db.prepare(`
    DELETE FROM download_queue
    WHERE id IN (
      SELECT id FROM download_queue
      WHERE processed_ts IS NOT NULL AND processed_ts < (strftime('%s','now') - 259200)
    )
  `).run();
}

// Fixed previously unterminated template literal and missing return
export function wasRecentlyDownloaded(telegram_id: string, target_username: string, hours: number): boolean {
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

export function isDuplicatePending(telegram_id: string, target_username: string): boolean {
  // Prevents same user/target combo being in queue at once
  const row = db.prepare(`
    SELECT id FROM download_queue
    WHERE telegram_id = ? AND target_username = ?
      AND (status = 'pending' OR status = 'processing')
    LIMIT 1
  `).get(telegram_id, target_username);
  return !!row;
}
