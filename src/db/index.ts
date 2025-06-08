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

// --- Schema Setup ---

// Users Table with premium expiration
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY NOT NULL,
    username TEXT,
    is_premium INTEGER DEFAULT 0,
    premium_until INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add premium_until column if database was created with an older schema
const userColumns = db.prepare("PRAGMA table_info(users)").all() as any[];
if (!userColumns.some((c) => c.name === 'premium_until')) {
  db.exec('ALTER TABLE users ADD COLUMN premium_until INTEGER');
}

// Download Queue Table
// CHANGE 1: Added the `task_details` column to store the full UserInfo object as JSON text.
db.exec(`
  CREATE TABLE IF NOT EXISTS download_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    target_username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, done, error
    enqueued_ts INTEGER NOT NULL,
    processed_ts INTEGER,
    error TEXT,
    task_details TEXT
  );
`);

// Monitored profiles table
db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    target_username TEXT NOT NULL,
    last_checked INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// Payments table for BTC invoices
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    invoice_amount REAL NOT NULL,
    user_address TEXT NOT NULL,
    from_address TEXT,
    paid_amount REAL DEFAULT 0,
    expires_at INTEGER,
    paid_at INTEGER
  );
`);

const paymentColumns = db.prepare("PRAGMA table_info(payments)").all() as any[];
if (!paymentColumns.some((c) => c.name === 'from_address')) {
  db.exec('ALTER TABLE payments ADD COLUMN from_address TEXT');
}

// ===== DB UTILS =====

// CHANGE 2: `enqueueDownload` now accepts the full UserInfo object and saves it.
export function enqueueDownload(telegram_id: string, target_username: string, task_details: UserInfo): void {
  const now = Math.floor(Date.now() / 1000);
  const detailsJson = JSON.stringify(task_details); // Convert object to JSON string for storage.
  
  const stmt = db.prepare(`
    INSERT INTO download_queue (telegram_id, target_username, enqueued_ts, status, task_details)
    VALUES (?, ?, ?, 'pending', ?)
  `);
  stmt.run(telegram_id, target_username, now, detailsJson);
}

// CHANGE 3: `getNextQueueItem` now correctly retrieves and parses the full task details.
export function getNextQueueItem(): DownloadQueueItem | null {
  const row: any = db.prepare(`
    SELECT q.*, u.is_premium
    FROM download_queue q
    LEFT JOIN users u ON u.telegram_id = q.telegram_id
    WHERE q.status = 'pending'
    ORDER BY u.is_premium DESC, q.enqueued_ts ASC
    LIMIT 1
  `).get();

  if (row && row.task_details) {
    // Parse the JSON string from the DB back into a full UserInfo object.
    const task: UserInfo = JSON.parse(row.task_details);

    // Re-attach the premium status from the JOIN query, as it's the most up-to-date.
    task.isPremium = row.is_premium === 1;
    
    return {
      id: row.id.toString(),
      chatId: row.telegram_id,
      task: task, // Use the fully preserved task object.
      status: row.status,
      enqueued_ts: row.enqueued_ts,
    };
  }
  return null;
}

// CHANGE 4: Added this new function to make the queue resilient to restarts.
/**
 * Finds any jobs that were stuck in a 'processing' state from a previous
 * run that crashed, and resets their status to 'pending'.
 */
export function resetStuckJobs(): void {
    try {
        console.log('[DB] Resetting any stuck "in-progress" jobs to "pending"...');
        const stmt = db.prepare(`
        UPDATE download_queue SET status = 'pending' WHERE status = 'processing'
        `);
        const info = stmt.run();
        if (info.changes > 0) {
            console.log(`[DB] Found and reset ${info.changes} stuck jobs.`);
        }
    } catch (error) {
        console.error('[DB] Failed to reset stuck jobs:', error);
    }
}


// --- These functions are correct as they are ---

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
    WHERE processed_ts IS NOT NULL AND processed_ts < (strftime('%s','now') - 2592000)
  `).run();
}

// Retrieve recent usage history limited to the last 30 days
export function getRecentHistory(limit: number): any[] {
  return db
    .prepare(
      `SELECT q.telegram_id, u.username, q.target_username, q.status, q.enqueued_ts, q.processed_ts
       FROM download_queue q
       LEFT JOIN users u ON u.telegram_id = q.telegram_id
       WHERE q.enqueued_ts > (strftime('%s','now') - 2592000)
       ORDER BY q.enqueued_ts DESC
       LIMIT ?`
    )
    .all(limit);
}

export function wasRecentlyDownloaded(telegram_id: string, target_username: string, hours: number): boolean {
  if (hours <= 0) return false;
  const cutoff = Math.floor(Date.now() / 1000) - (hours * 3600);
  const row = db.prepare(`
    SELECT id FROM download_queue
    WHERE telegram_id = ? AND target_username = ? AND status = 'done' AND processed_ts > ?
    LIMIT 1
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

// ----- Monitor utils -----
export interface MonitorRow {
  id: number;
  telegram_id: string;
  target_username: string;
  last_checked?: number;
}

export function addMonitor(
  telegram_id: string,
  target_username: string
): MonitorRow {
  const result = db
    .prepare(
      `INSERT INTO monitors (telegram_id, target_username)
       VALUES (?, ?)`
    )
    .run(telegram_id, target_username);

  const id = Number(result.lastInsertRowid);
  return {
    id,
    telegram_id,
    target_username,
  };
}

export function removeMonitor(
  telegram_id: string,
  target_username: string
): void {
  db.prepare(
    `DELETE FROM monitors WHERE telegram_id = ? AND target_username = ?`
  ).run(telegram_id, target_username);
}

export function listMonitors(telegram_id: string): MonitorRow[] {
  return db.prepare(`SELECT * FROM monitors WHERE telegram_id = ?`).all(telegram_id) as MonitorRow[];
}

export function listAllMonitors(): MonitorRow[] {
  return db.prepare(`SELECT * FROM monitors`).all() as MonitorRow[];
}

export function getMonitor(id: number): MonitorRow | undefined {
  return db
    .prepare(`SELECT * FROM monitors WHERE id = ?`)
    .get(id) as MonitorRow | undefined;
}

export function findMonitor(
  telegram_id: string,
  target_username: string
): MonitorRow | undefined {
  return db
    .prepare(
      `SELECT * FROM monitors WHERE telegram_id = ? AND target_username = ?`
    )
    .get(telegram_id, target_username) as MonitorRow | undefined;
}

export function countMonitors(telegram_id: string): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM monitors WHERE telegram_id = ?`).get(telegram_id) as { c: number };
  return row?.c || 0;
}

export function getDueMonitors(cutoff: number): MonitorRow[] {
  return db.prepare(
    `SELECT * FROM monitors WHERE last_checked IS NULL OR last_checked < ?`
  ).all(cutoff) as MonitorRow[];
}

export function updateMonitorChecked(id: number): void {
  db.prepare(`UPDATE monitors SET last_checked = strftime('%s','now') WHERE id = ?`).run(id);
}

// ----- Payment utils -----
export interface PaymentRow {
  id: number;
  user_id: string;
  invoice_amount: number;
  user_address: string;
  from_address?: string | null;
  paid_amount: number;
  expires_at?: number;
  paid_at?: number | null;
}

export function insertInvoice(
  user_id: string,
  invoice_amount: number,
  user_address: string,
  expires_at: number,
  from_address?: string | null
): PaymentRow {
  const result = db
    .prepare(
      `INSERT INTO payments (user_id, invoice_amount, user_address, from_address, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(user_id, invoice_amount, user_address, from_address ?? null, expires_at);

  const id = Number(result.lastInsertRowid);
  return getInvoice(id)!;
}

export function updatePaidAmount(id: number, amount: number): void {
  db.prepare(`UPDATE payments SET paid_amount = paid_amount + ? WHERE id = ?`).run(amount, id);
}

export function updateFromAddress(id: number, from_address: string): void {
  db.prepare(`UPDATE payments SET from_address = ? WHERE id = ?`).run(from_address, id);
}

export function markInvoicePaid(id: number): void {
  db.prepare(`UPDATE payments SET paid_at = strftime('%s','now') WHERE id = ?`).run(id);
}

export function getInvoice(id: number): PaymentRow | undefined {
  return db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id) as PaymentRow | undefined;
}
