// src/db/index.ts

import SyncDatabase from './sqlite-sync';
import fs from 'fs';
import path from 'path';
import { DownloadQueueItem, UserInfo } from 'types';

/**
 * Base directory where all runtime data is stored inside the container.
 * The Docker compose file mounts a persistent host directory to `/data`.
 */
export const DATA_DIR = '/data';
export const DB_PATH = path.join(DATA_DIR, 'database.db');
// Ensure the data directory exists before using it
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const db = new SyncDatabase(DB_PATH);

// --- Schema Setup ---

// Users Table with premium expiration
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY NOT NULL,
    username TEXT,
    language TEXT,
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
if (!userColumns.some((c) => c.name === 'language')) {
  db.exec('ALTER TABLE users ADD COLUMN language TEXT');
}

// Track hashes of usernames that belonged to deleted accounts to prevent
// free-trial abuse by recreating accounts with the same username.
db.exec(`
  CREATE TABLE IF NOT EXISTS deleted_usernames (
    username_hash TEXT PRIMARY KEY
  );
`);

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
    target_id TEXT,
    target_username TEXT,
    target_access_hash TEXT,
    last_checked INTEGER,
    last_photo_id TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);
const monitorColumns = db.prepare("PRAGMA table_info(monitors)").all() as any[];
if (!monitorColumns.some((c) => c.name === 'last_photo_id')) {
  db.exec('ALTER TABLE monitors ADD COLUMN last_photo_id TEXT');
}
if (!monitorColumns.some((c) => c.name === 'target_id')) {
  db.exec('ALTER TABLE monitors ADD COLUMN target_id TEXT');
}
if (!monitorColumns.some((c) => c.name === 'target_access_hash')) {
  db.exec('ALTER TABLE monitors ADD COLUMN target_access_hash TEXT');
}
db.exec('DROP INDEX IF EXISTS monitor_unique_idx');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS monitor_unique_idx ON monitors (telegram_id, target_id)');

// Table storing which stories were already sent for each monitor
db.exec(`
  CREATE TABLE IF NOT EXISTS monitor_sent_stories (
    monitor_id INTEGER NOT NULL,
    story_id INTEGER NOT NULL,
    story_date INTEGER NOT NULL,
    story_key TEXT NOT NULL,
    story_type TEXT NOT NULL DEFAULT 'active',
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (monitor_id, story_key, story_type)
  );
`);

const sentColumns = db.prepare("PRAGMA table_info(monitor_sent_stories)").all() as any[];
if (!sentColumns.some((c) => c.name === 'story_date')) {
  db.exec('ALTER TABLE monitor_sent_stories ADD COLUMN story_date INTEGER');
}
if (!sentColumns.some((c) => c.name === 'story_key')) {
  db.exec('ALTER TABLE monitor_sent_stories ADD COLUMN story_key TEXT');
}
if (!sentColumns.some((c) => c.name === 'story_type')) {
  db.exec("ALTER TABLE monitor_sent_stories ADD COLUMN story_type TEXT DEFAULT 'active'");
}
db.exec('DROP INDEX IF EXISTS monitor_sent_idx');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS monitor_sent_idx ON monitor_sent_stories (monitor_id, story_key, story_type)');

db.exec(`
  CREATE TABLE IF NOT EXISTS hidden_story_cache (
    peer_id TEXT NOT NULL,
    access_hash TEXT,
    story_id INTEGER NOT NULL,
    media TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (peer_id, story_id)
  );
`);

try {
  db.prepare('DELETE FROM hidden_story_cache WHERE expires_at <= ?').run(Math.floor(Date.now() / 1000));
} catch (err) {
  console.error('[DB] Failed to prune hidden story cache:', err);
}
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

// Log of all download requests for global rate limiting
db.exec(`
  CREATE TABLE IF NOT EXISTS user_request_log (
    telegram_id TEXT NOT NULL,
    requested_at INTEGER NOT NULL
  );
`);

// Track last /verify command per user
db.exec(`
  CREATE TABLE IF NOT EXISTS verify_attempts (
    telegram_id TEXT PRIMARY KEY,
    last_attempt INTEGER NOT NULL
  );
`);

// Invitation codes table - maps each user to a unique code they can share
db.exec(`
  CREATE TABLE IF NOT EXISTS invite_codes (
    user_id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// Referrals table - tracks who invited whom and reward status
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    inviter_id TEXT NOT NULL,
    new_user_id TEXT PRIMARY KEY,
    paid_rewarded INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// Track invalid link violations and temporary suspensions
db.exec(`
  CREATE TABLE IF NOT EXISTS invalid_link_violations (
    telegram_id TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    suspended_until INTEGER
  );
`);

// Bug reports table
db.exec(`
  CREATE TABLE IF NOT EXISTS bug_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    username TEXT,
    description TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ===== DB UTILS =====

// CHANGE 2: `enqueueDownload` now accepts the full UserInfo object and saves it.
export function enqueueDownload(
  telegram_id: string,
  target_username: string,
  task_details: UserInfo,
  delaySeconds = 0,
): number {
  const now = Math.floor(Date.now() / 1000) + delaySeconds;
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
 * Finds any jobs that were left in a 'processing' or 'error' state from a
 * previous run that crashed, and resets their status to 'pending'.
 */
export function resetStuckJobs(): void {
  try {
    console.log('[DB] Resetting any stuck jobs back to "pending"...');

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

    const total = (resetInfo.changes as number) + (deleteInfo.changes as number);
    if (total > 0) {
      console.log(
        `[DB] Reset ${resetInfo.changes} stuck jobs. Removed ${deleteInfo.changes} old errors.`
      );
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

export function flushQueue(): number {
  const result = db.prepare(
    `DELETE FROM download_queue WHERE status IN ('pending','processing','error')`
  ).run();
  return result.changes as number;
}

let lastMaintenance = 0;
export function runMaintenance(): void {
  const now = Math.floor(Date.now() / 1000);
  if (now - lastMaintenance < 86400) return;
  lastMaintenance = now;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec('VACUUM;');
    db.exec('PRAGMA optimize;');
  } catch (err) {
    console.error('[DB] Maintenance error:', err);
  }
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
  target_id: string;
  target_username: string | null;
  target_access_hash: string | null;
  last_checked?: number;
  last_photo_id?: string | null;
}

export function addMonitor(
  telegram_id: string,
  target_id: string,
  target_username: string | null,
  target_access_hash?: string | null,
  last_photo_id?: string | null,
): MonitorRow {
  db.prepare(
    `INSERT OR IGNORE INTO monitors (telegram_id, target_id, target_username, target_access_hash, last_photo_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(telegram_id, target_id, target_username, target_access_hash ?? null, last_photo_id ?? null);
  const row = findMonitorByTargetId(telegram_id, target_id)!;
  return row;
}

export function removeMonitor(
  telegram_id: string,
  target_id: string
): void {
  db.prepare(
    `DELETE FROM monitors WHERE telegram_id = ? AND target_id = ?`
  ).run(telegram_id, target_id);
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

export function findMonitorByTargetId(
  telegram_id: string,
  target_id: string
): MonitorRow | undefined {
  return db
    .prepare(
      `SELECT * FROM monitors WHERE telegram_id = ? AND target_id = ?`
    )
    .get(telegram_id, target_id) as MonitorRow | undefined;
}

export function findMonitorByUsername(
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

export function updateMonitorPhoto(id: number, last_photo_id: string | null): void {
  db.prepare(`UPDATE monitors SET last_photo_id = ? WHERE id = ?`).run(last_photo_id, id);
}

export function updateMonitorUsername(id: number, username: string | null): void {
  db.prepare(`UPDATE monitors SET target_username = ? WHERE id = ?`).run(username, id);
}

export function updateMonitorTarget(id: number, target_id: string): void {
  db.prepare(`UPDATE monitors SET target_id = ? WHERE id = ?`).run(target_id, id);
}

export function updateMonitorAccessHash(
  id: number,
  target_access_hash: string | null,
): void {
  db.prepare(`UPDATE monitors SET target_access_hash = ? WHERE id = ?`).run(target_access_hash, id);
}

// ----- Monitor sent stories utils -----
export function markStorySent(
  monitor_id: number,
  story_id: number,
  story_date: number,
  expires_at: number | null,
  story_type: 'active' | 'pinned' = 'active',
): void {
  const story_key = `${story_id}:${story_date}`;
  const normalizedExpiresAt =
    story_type === 'pinned'
      ? 0
      : expires_at ?? 0;
  db.prepare(
    `INSERT OR REPLACE INTO monitor_sent_stories (monitor_id, story_id, story_date, story_key, story_type, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(monitor_id, story_id, story_date, story_key, story_type, normalizedExpiresAt);
}

export function listSentStoryKeys(
  monitor_id: number,
  story_type: 'active' | 'pinned' = 'active',
): string[] {
  const now = Math.floor(Date.now() / 1000);
  const rows =
    story_type === 'pinned'
      ? (db
          .prepare(
            `SELECT story_key FROM monitor_sent_stories WHERE monitor_id = ? AND story_type = ?`,
          )
          .all(monitor_id, story_type) as { story_key: string }[])
      : (db
          .prepare(
            `SELECT story_key FROM monitor_sent_stories WHERE monitor_id = ? AND story_type = ? AND expires_at > ?`,
          )
          .all(monitor_id, story_type, now) as { story_key: string }[]);
  return rows.map((r) => r.story_key);
}

export function cleanupExpiredSentStories(): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`DELETE FROM monitor_sent_stories WHERE story_type != 'pinned' AND expires_at <= ?`).run(now);
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

// ----- Rate limiting utils -----
export function recordUserRequest(telegram_id: string): void {
  db.prepare(
    `INSERT INTO user_request_log (telegram_id, requested_at) VALUES (?, strftime('%s','now'))`,
  ).run(telegram_id);
}

export function countRecentUserRequests(
  telegram_id: string,
  windowSeconds: number,
): number {
  const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM user_request_log WHERE telegram_id = ? AND requested_at > ?`,
    )
    .get(telegram_id, cutoff) as { c: number };
  return row.c || 0;
}

export function countPendingJobs(telegram_id: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM download_queue WHERE telegram_id = ? AND status IN ('pending','processing')`,
    )
    .get(telegram_id) as { c: number };
  return row.c || 0;
}

export function getLastVerifyAttempt(telegram_id: string): number | undefined {
  const row = db
    .prepare(`SELECT last_attempt FROM verify_attempts WHERE telegram_id = ?`)
    .get(telegram_id) as { last_attempt: number } | undefined;
  return row?.last_attempt;
}

export function updateVerifyAttempt(telegram_id: string): void {
  db.prepare(
    `INSERT INTO verify_attempts (telegram_id, last_attempt) VALUES (?, strftime('%s','now'))
     ON CONFLICT(telegram_id) DO UPDATE SET last_attempt = excluded.last_attempt`,
  ).run(telegram_id);
}

// ----- Invitation/Referral utilities -----
export function getOrCreateInviteCode(user_id: string): string {
  let row = db.prepare(`SELECT code FROM invite_codes WHERE user_id = ?`).get(user_id) as { code: string } | undefined;
  if (row) return row.code;
  const code = Math.random().toString(36).slice(2, 8);
  db.prepare(`INSERT INTO invite_codes (user_id, code) VALUES (?, ?)`).run(user_id, code);
  return code;
}

export function findInviterByCode(code: string): string | undefined {
  const row = db.prepare(`SELECT user_id FROM invite_codes WHERE code = ?`).get(code) as { user_id: string } | undefined;
  return row?.user_id;
}

export function recordReferral(inviter_id: string, new_user_id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO referrals (inviter_id, new_user_id) VALUES (?, ?)`,
  ).run(inviter_id, new_user_id);
}

export function countReferrals(inviter_id: string): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM referrals WHERE inviter_id = ?`).get(inviter_id) as { c: number };
  return row.c || 0;
}

export function getInviterForUser(new_user_id: string): string | undefined {
  const row = db.prepare(`SELECT inviter_id FROM referrals WHERE new_user_id = ?`).get(new_user_id) as { inviter_id: string } | undefined;
  return row?.inviter_id;
}

export function markReferralPaidRewarded(new_user_id: string): void {
  db.prepare(`UPDATE referrals SET paid_rewarded = 1 WHERE new_user_id = ?`).run(new_user_id);
}

export function wasReferralPaidRewarded(new_user_id: string): boolean {
  const row = db.prepare(`SELECT paid_rewarded FROM referrals WHERE new_user_id = ?`).get(new_user_id) as { paid_rewarded: number } | undefined;
  return row?.paid_rewarded === 1;
}

// ===== Invalid link violation utilities =====

export function recordInvalidLink(telegram_id: string): number {
  db.prepare(
    `INSERT INTO invalid_link_violations (telegram_id, count)
     VALUES (?, 1)
     ON CONFLICT(telegram_id) DO UPDATE SET count = count + 1`
  ).run(telegram_id);
  const row = db
    .prepare('SELECT count FROM invalid_link_violations WHERE telegram_id = ?')
    .get(telegram_id) as { count: number };
  return row.count;
}

export function suspendUserTemp(telegram_id: string, seconds: number): void {
  const until = Math.floor(Date.now() / 1000) + seconds;
  db.prepare(
    `INSERT INTO invalid_link_violations (telegram_id, count, suspended_until)
     VALUES (?, 0, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET count = 0, suspended_until = ?`
  ).run(telegram_id, until, until);
}

export function getSuspensionRemaining(telegram_id: string): number {
  const row = db
    .prepare('SELECT suspended_until FROM invalid_link_violations WHERE telegram_id = ?')
    .get(telegram_id) as { suspended_until?: number } | undefined;
  if (!row?.suspended_until) return 0;
  const now = Math.floor(Date.now() / 1000);
  if (row.suspended_until <= now) {
    db.prepare('UPDATE invalid_link_violations SET suspended_until = NULL WHERE telegram_id = ?').run(telegram_id);
    return 0;
  }
  return row.suspended_until - now;
}

export function isUserTemporarilySuspended(telegram_id: string): boolean {
  return getSuspensionRemaining(telegram_id) > 0;
}

// ====== Stats helpers ======

export function countNewUsersSince(since: number): number {
  const row = db
    .prepare("SELECT COUNT(*) as c FROM users WHERE strftime('%s', created_at) > ?")
    .get(since) as { c: number } | undefined;
  return row?.c || 0;
}

export function countPaymentsSince(since: number): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) as c FROM payments WHERE paid_at IS NOT NULL AND paid_at > ?",
    )
    .get(since) as { c: number } | undefined;
  return row?.c || 0;
}

export function countReferralsSince(since: number): number {
  const row = db
    .prepare("SELECT COUNT(*) as c FROM referrals WHERE created_at > ?")
    .get(since) as { c: number } | undefined;
  return row?.c || 0;
}

// ----- Bug reports utils -----
export interface BugReportRow {
  id: number;
  telegram_id: string;
  username?: string;
  description: string;
  created_at: number;
}

export function cleanupOldBugs(): void {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  db.prepare('DELETE FROM bug_reports WHERE created_at < ?').run(cutoff);
}

export function addBugReport(
  telegram_id: string,
  description: string,
  username?: string,
): void {
  cleanupOldBugs();
  db.prepare(
    `INSERT INTO bug_reports (telegram_id, username, description) VALUES (?, ?, ?)`,
  ).run(telegram_id, username ?? null, description);
}

export function listBugReports(): BugReportRow[] {
  cleanupOldBugs();
  return db
    .prepare(
      `SELECT id, telegram_id, username, description, created_at FROM bug_reports ORDER BY created_at DESC`,
    )
    .all() as BugReportRow[];
}

export function getLastBugReportTime(telegram_id: string): number | undefined {
  cleanupOldBugs();
  const row = db
    .prepare(
      `SELECT created_at FROM bug_reports WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(telegram_id) as { created_at: number } | undefined;
  return row?.created_at;
}

export function countBugReportsLastDay(telegram_id: string): number {
  cleanupOldBugs();
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM bug_reports WHERE telegram_id = ? AND created_at >= ?`,
    )
    .get(telegram_id, cutoff) as { c: number } | undefined;
  return row?.c || 0;
}

export function getEarliestBugReportTimeLastDay(
  telegram_id: string,
): number | undefined {
  cleanupOldBugs();
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const row = db
    .prepare(
      `SELECT MIN(created_at) as c FROM bug_reports WHERE telegram_id = ? AND created_at >= ?`,
    )
    .get(telegram_id, cutoff) as { c: number } | undefined;
  return row?.c;
}
