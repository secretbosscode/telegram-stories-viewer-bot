// src/db/index.ts

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DownloadQueueItem, UserInfo } from 'types';

const DB_PATH = path.join(__dirname, '../../data/database.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new Database(DB_PATH);

// Users Table (Unchanged)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY NOT NULL,
    username TEXT,
    is_premium INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

// =========================================================================
// FINAL FIX 1: Add a 'task_details' column to store the full UserInfo object.
// =========================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS download_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    target_username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, done, error
    enqueued_ts INTEGER NOT NULL,
    processed_ts INTEGER,
    error TEXT,
    task_details TEXT -- This new column will store the task as a JSON string
  );
`);

// ===== DB UTILS =====

// =========================================================================
// FINAL FIX 2: Update enqueueDownload to accept and store the task_details.
// =========================================================================
export function enqueueDownload(telegram_id: string, target_username: string, task_details: UserInfo): void {
  const now = Math.floor(Date.now() / 1000);
  const detailsJson = JSON.stringify(task_details); // Convert the object to a string for storage
  db.prepare(`
    INSERT INTO download_queue (telegram_id, target_username, enqueued_ts, status, task_details)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(telegram_id, target_username, now, detailsJson);
}

// =========================================================================
// FINAL FIX 3: Update getNextQueueItem to retrieve and parse task_details.
// =========================================================================
export function getNextQueueItem(): DownloadQueueItem | null {
  // This query is simplified as we no longer need the complex JOIN just to get premium status
  const row: any = db.prepare(`
    SELECT * FROM download_queue
    WHERE status = 'pending'
    ORDER BY enqueued_ts ASC
    LIMIT 1
  `).get();

  if (row) {
    // The task object is now parsed directly from the database, not recreated.
    const task: UserInfo = JSON.parse(row.task_details);
    
    return {
      id: row.id.toString(),
      chatId: row.telegram_id,
      task: task, // Use the fully preserved task object
      status: row.status,
      enqueued_ts: row.enqueued_ts,
    };
  }
  return null;
}


// --- The rest of these functions are mostly correct ---

export function markProcessing(id: string): void {
  db.prepare(`UPDATE download_queue SET status = 'processing' WHERE id = ?`).run(id);
}

export function markDone(id: string): void {
  db.prepare(`UPDATE download_queue SET status = 'done', processed_ts = ? WHERE id = ?`).run(Math.floor(Date.now() / 1000), id);
}

export function markError(id: string, error: string): void {
  db.prepare(`UPDATE download_queue SET status = 'error', error = ?, processed_ts = ? WHERE id = ?`).run(error, Math.floor(Date.now() / 1000), id);
}

export function cleanupQueue(): void {
  db.prepare(`
    DELETE FROM download_queue
    WHERE processed_ts IS NOT NULL AND processed_ts < (strftime('%s','now') - 259200)
  `).run();
}

export function wasRecentlyDownloaded(telegram_id: string, target_username: string, hours: number): boolean {
  if (hours <= 0) return false;
  const cutoff = Math.floor(Date.now() / 1000) - (hours * 3600);
  const row = db.prepare(`
    SELECT id FROM download_queue
    WHERE telegram_id = ? AND target_username = ? AND status = 'done' AND processed_ts > ?
    ORDER BY processed_ts DESC LIMIT 1
  `).get(telegram_id, target_username, cutoff);
  return !!row;
}

export function isDuplicatePending(telegram_id: string, target_username: string): boolean {
  const row = db.prepare(`
    SELECT id FROM download_queue
    WHERE telegram_id = ? AND target_username = ? AND (status = 'pending' OR status = 'processing')
    LIMIT 1
  `).get(telegram_id, target_username);
  return !!row;
}
