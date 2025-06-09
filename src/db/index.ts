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
    is_bot INTEGER DEFAULT 0,
    is_premium INTEGER DEFAULT 0,
    free_trial_used INTEGER DEFAULT 0,
    premium_until INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add premium_until column if database was created with an older schema
const userColumns = db.prepare("PRAGMA table_info(users)").all() as any[];
if (!userColumns.some((c) => c.name === 'premium_until')) {
  db.exec('ALTER TABLE users ADD COLUMN premium_until INTEGER');
}
if (!userColumns.some((c) => c.name === 'free_trial_used')) {
  db.exec("ALTER TABLE users ADD COLUMN free_trial_used INTEGER DEFAULT 0");
}
if (!userColumns.some((c) => c.name === 'pinned_message_id')) {
  db.exec('ALTER TABLE users ADD COLUMN pinned_message_id INTEGER');
}
if (!userColumns.some((c) => c.name === 'pinned_message_updated_at')) {
  db.exec('ALTER TABLE users ADD COLUMN pinned_message_updated_at INTEGER');
}
if (!userColumns.some((c) => c.name === 'is_bot')) {
  db.exec('ALTER TABLE users ADD COLUMN is_bot INTEGER DEFAULT 0');
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

// Table storing which stories were already sent for each monitor
db.exec(`
  CREATE TABLE IF NOT EXISTS monitor_sent_stories (
    monitor_id INTEGER NOT NULL,
    story_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (monitor_id, story_id)
  );
`);

// Payments table for BTC invoices
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    invoice_amount REAL NOT NULL,
    user_address TEXT NOT NULL,
    address_index INTEGER,
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
if (!paymentColumns.some((c) => c.name === 'address_index')) {
  db.exec('ALTER TABLE payments ADD COLUMN address_index INTEGER');
}

// Wallet state table for HD wallet index persistence
db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_state (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    next_index INTEGER DEFAULT 0
  );
`);
const walletRow = db.prepare('SELECT next_index FROM wallet_state WHERE id = 0').get() as any;
if (!walletRow) {
  db.prepare('INSERT INTO wallet_state (id, next_index) VALUES (0, 0)').run();
}

export function reserveAddressIndex(): number {
  const row = db.prepare('SELECT next_index FROM wallet_state WHERE id = 0').get() as any;
  const idx = row?.next_index ?? 0;
  db.prepare('UPDATE wallet_state SET next_index = ? WHERE id = 0').run(idx + 1);
  return idx;
}

// Table to store used transaction ids
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_txids (
    invoice_id INTEGER NOT NULL,
    txid TEXT NOT NULL UNIQUE
  );
`);

// Payment checks table to persist pending invoice checks across restarts
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_checks (
    invoice_id INTEGER PRIMARY KEY,
    next_check INTEGER NOT NULL,
    check_start INTEGER NOT NULL
  );
`);

// Blocked users table
db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_users (
    telegram_id TEXT PRIMARY KEY,
    blocked_at INTEGER DEFAULT (strftime('%s','now')),
    is_bot INTEGER DEFAULT 0
  );
`);
const blockedColumns = db.prepare("PRAGMA table_info(blocked_users)").all() as any[];
if (!blockedColumns.some((c) => c.name === 'is_bot')) {
  db.exec('ALTER TABLE blocked_users ADD COLUMN is_bot INTEGER DEFAULT 0');
}

// Store recent profile media requests for anti-spam checks
db.exec(`
  CREATE TABLE IF NOT EXISTS profile_requests (
    telegram_id TEXT NOT NULL,
    target_username TEXT NOT NULL,
    requested_at INTEGER NOT NULL
  );
`);

// ===== DB UTILS =====

// CHANGE 2: `enqueueDownload` now accepts the full UserInfo object and saves it.
export function enqueueDownload(
  telegram_id: string,
  target_username: string,
  task_details: UserInfo,
): number {
  const now = Math.floor(Date.now() / 1000);
  const detailsJson = JSON.stringify(task_details); // Convert object to JSON string for storage.

  const stmt = db.prepare(`
    INSERT INTO download_queue (telegram_id, target_username, enqueued_ts, status, task_details)
    VALUES (?, ?, ?, 'pending', ?)
  `);
  const info = stmt.run(telegram_id, target_username, now, detailsJson);
  return Number(info.lastInsertRowid);
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
      `SELECT q.telegram_id, u.username, u.is_bot, q.target_username, q.status, q.enqueued_ts, q.processed_ts
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

export function getDownloadCooldownRemaining(
  telegram_id: string,
  target_username: string,
  hours: number,
): number {
  if (hours <= 0) return 0;
  const row = db
    .prepare(
      `SELECT processed_ts FROM download_queue
       WHERE telegram_id = ? AND target_username = ? AND status = 'done'
       ORDER BY processed_ts DESC
       LIMIT 1`,
    )
    .get(telegram_id, target_username) as { processed_ts: number } | undefined;
  if (!row) return 0;
  const expiresAt = row.processed_ts + hours * 3600;
  const remaining = expiresAt - Math.floor(Date.now() / 1000);
  return remaining > 0 ? remaining : 0;
}

export function recordProfileRequest(telegram_id: string, target_username: string): void {
  db.prepare(
    `INSERT INTO profile_requests (telegram_id, target_username, requested_at) VALUES (?, ?, strftime('%s','now'))`,
  ).run(telegram_id, target_username);
}

export function wasProfileRequestedRecently(
  telegram_id: string,
  target_username: string,
  hours: number,
): boolean {
  if (hours <= 0) return false;
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  const row = db
    .prepare(
      `SELECT 1 FROM profile_requests WHERE telegram_id = ? AND target_username = ? AND requested_at > ? LIMIT 1`,
    )
    .get(telegram_id, target_username, cutoff);
  return !!row;
}

export function getProfileRequestCooldownRemaining(
  telegram_id: string,
  target_username: string,
  hours: number,
): number {
  if (hours <= 0) return 0;
  const row = db
    .prepare(
      `SELECT requested_at FROM profile_requests
       WHERE telegram_id = ? AND target_username = ?
       ORDER BY requested_at DESC
       LIMIT 1`,
    )
    .get(telegram_id, target_username) as { requested_at: number } | undefined;
  if (!row) return 0;
  const expiresAt = row.requested_at + hours * 3600;
  const remaining = expiresAt - Math.floor(Date.now() / 1000);
  return remaining > 0 ? remaining : 0;
}

export function isDuplicatePending(
  telegram_id: string,
  target_username: string,
  nextStoriesIds?: number[],
): boolean {
  if (nextStoriesIds && nextStoriesIds.length > 0) {
    const row = db
      .prepare(
        `SELECT id FROM download_queue
         WHERE telegram_id = ?
           AND target_username = ?
           AND json_extract(task_details, '$.nextStoriesIds') = json(?)
           AND (status = 'pending' OR status = 'processing')
         LIMIT 1`,
      )
      .get(telegram_id, target_username, JSON.stringify(nextStoriesIds));
    return !!row;
  }

  const row = db
    .prepare(
      `SELECT id FROM download_queue
       WHERE telegram_id = ? AND target_username = ? AND (status = 'pending' OR status = 'processing')
       LIMIT 1`,
    )
    .get(telegram_id, target_username);
  return !!row;
}

export function findPendingJobId(telegram_id: string): number | undefined {
  const row = db.prepare(
    `SELECT id FROM download_queue WHERE telegram_id = ? AND status = 'pending' ORDER BY enqueued_ts ASC LIMIT 1`,
  ).get(telegram_id) as { id?: number } | undefined;
  return row?.id;
}

export function getQueueStats(jobId: number): { position: number; eta: number } {
  const job = db
    .prepare(
      `SELECT q.enqueued_ts, IFNULL(u.is_premium,0) as is_premium FROM download_queue q LEFT JOIN users u ON u.telegram_id = q.telegram_id WHERE q.id = ?`,
    )
    .get(jobId) as { enqueued_ts: number; is_premium: number } | undefined;

  if (!job) return { position: -1, eta: 0 };

  const ahead = db
    .prepare(
      `SELECT COUNT(*) as c FROM download_queue q LEFT JOIN users u ON u.telegram_id = q.telegram_id WHERE q.status = 'pending' AND (u.is_premium > @p OR (u.is_premium = @p AND q.enqueued_ts < @t))`,
    )
    .get({ p: job.is_premium, t: job.enqueued_ts }) as { c: number };

  const processing = db.prepare(`SELECT COUNT(*) as c FROM download_queue WHERE status = 'processing'`).get() as { c: number };

  const position = ahead.c + processing.c + 1;

  const avgRow = db
    .prepare(`SELECT AVG(processed_ts - enqueued_ts) as avg FROM download_queue WHERE processed_ts IS NOT NULL`)
    .get() as { avg: number | null };
  const avg = avgRow && avgRow.avg ? avgRow.avg : 30;

  return { position, eta: Math.round(avg * (position - 1)) };
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

// ----- Monitor sent stories utils -----
export function markStorySent(
  monitor_id: number,
  story_id: number,
  expires_at: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monitor_sent_stories (monitor_id, story_id, expires_at) VALUES (?, ?, ?)`,
  ).run(monitor_id, story_id, expires_at);
}

export function listSentStoryIds(monitor_id: number): number[] {
  const now = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT story_id FROM monitor_sent_stories WHERE monitor_id = ? AND expires_at > ?`,
    )
    .all(monitor_id, now) as { story_id: number }[];
  return rows.map((r) => r.story_id);
}

export function cleanupExpiredSentStories(): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`DELETE FROM monitor_sent_stories WHERE expires_at <= ?`).run(now);
}

// ----- Payment utils -----
export interface PaymentRow {
  id: number;
  user_id: string;
  invoice_amount: number;
  user_address: string;
  address_index?: number | null;
  from_address?: string | null;
  paid_amount: number;
  expires_at?: number;
  paid_at?: number | null;
}

export function insertInvoice(
  user_id: string,
  invoice_amount: number,
  user_address: string,
  address_index: number | null,
  expires_at: number,
  from_address?: string | null,
): PaymentRow {
  const result = db
    .prepare(
      `INSERT INTO payments (user_id, invoice_amount, user_address, address_index, from_address, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(user_id, invoice_amount, user_address, address_index, from_address ?? null, expires_at);

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

export function getPendingInvoiceByAddress(address: string): PaymentRow | undefined {
  return db
    .prepare(
      `SELECT * FROM payments WHERE user_address = ? AND paid_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(address) as PaymentRow | undefined;
}

export function getActiveInvoiceForUser(user_id: string): PaymentRow | undefined {
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT * FROM payments WHERE user_id = ? AND paid_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1`,
    )
    .get(user_id, now) as PaymentRow | undefined;
}

// ----- Payment txid utils -----
export function recordTxid(invoice_id: number, txid: string): void {
  db.prepare(`INSERT OR IGNORE INTO payment_txids (invoice_id, txid) VALUES (?, ?)`)
    .run(invoice_id, txid);
}

export function isTxidUsed(txid: string): boolean {
  const row = db.prepare(`SELECT 1 FROM payment_txids WHERE txid = ?`).get(txid);
  return !!row;
}

// ----- Payment check persistence -----
export interface PaymentCheckRow {
  invoice_id: number;
  next_check: number;
  check_start: number;
}

export function upsertPaymentCheck(
  invoice_id: number,
  next_check: number,
  check_start?: number,
): void {
  db.prepare(
    `INSERT INTO payment_checks (invoice_id, next_check, check_start)
     VALUES (?, ?, ?)
     ON CONFLICT(invoice_id) DO UPDATE SET next_check = excluded.next_check`
  ).run(invoice_id, next_check, check_start ?? Math.floor(Date.now() / 1000));
}

export function deletePaymentCheck(invoice_id: number): void {
  db.prepare(`DELETE FROM payment_checks WHERE invoice_id = ?`).run(invoice_id);
}

export function listPaymentChecks(): PaymentCheckRow[] {
  return db
    .prepare(`SELECT invoice_id, next_check, check_start FROM payment_checks`)
    .all() as PaymentCheckRow[];
}

// ----- Blocked users utils -----
export interface BlockedUserRow {
  telegram_id: string;
  blocked_at: number;
  is_bot: number;
}

export function blockUser(telegram_id: string, is_bot = false): void {
  db.prepare(
    `INSERT OR REPLACE INTO blocked_users (telegram_id, blocked_at, is_bot) VALUES (?, strftime('%s','now'), ?)`
  ).run(telegram_id, is_bot ? 1 : 0);
}

export function unblockUser(telegram_id: string): void {
  db.prepare(`DELETE FROM blocked_users WHERE telegram_id = ?`).run(telegram_id);
}

export function isUserBlocked(telegram_id: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM blocked_users WHERE telegram_id = ?`)
    .get(telegram_id);
  return !!row;
}

export function listBlockedUsers(): BlockedUserRow[] {
  return db
    .prepare(`SELECT telegram_id, blocked_at, is_bot FROM blocked_users`)
    .all() as BlockedUserRow[];
}
