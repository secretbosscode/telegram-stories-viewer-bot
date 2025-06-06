// src/db/index.ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DownloadQueueItem } from 'types'; // Import DownloadQueueItem from your types file

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
      task: {
        chatId: row.telegram_id, // Redundant but explicit, UserInfo is also expected in task
        link: row.target_username, // Map target_username to link
        linkType: 'username', // Default, or infer if possible from DB data
        locale: 'en', // Default, or get from user table if stored
        user: undefined, // No user object from this query, set to undefined
        initTime: row.enqueued_ts * 1000, // Convert seconds to milliseconds
        isPremium: row.is_premium === 1, // Convert INTEGER 0/1 to boolean
      },
      status: row.status as 'pending' | 'in_progress' | 'done' | 'error', // Cast DB string to union type
    };
  }
  return null;
}

// Corrected parameter type for id from number to string
export function markProcessing(id: string): void {
  db.prepare(`UPDATE download_queue SET status = 'processing' WHERE
