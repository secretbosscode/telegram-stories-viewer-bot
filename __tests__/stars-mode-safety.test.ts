import { jest } from '@jest/globals';

jest.mock('../src/db', () => {
  const SyncDatabase = require('../src/db/sqlite-sync').default;
  const db = new SyncDatabase(':memory:');
  db.exec(`
    CREATE TABLE bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      invoice_amount REAL,
      user_address TEXT,
      paid_amount REAL DEFAULT 0,
      expires_at INTEGER,
      paid_at INTEGER
    );
    CREATE TABLE payment_checks (
      invoice_id INTEGER PRIMARY KEY,
      next_check INTEGER NOT NULL,
      check_start INTEGER NOT NULL
    );
    CREATE TABLE users (
      telegram_id TEXT PRIMARY KEY,
      is_premium INTEGER DEFAULT 0,
      premium_until INTEGER
    );
    CREATE TABLE monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      target_id TEXT,
      target_username TEXT,
      target_access_hash TEXT,
      last_checked INTEGER,
      last_photo_id TEXT,
      created_at INTEGER DEFAULT 0
    );
    CREATE TABLE star_result_bundles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      target TEXT NOT NULL,
      locale TEXT NOT NULL,
      request_kind TEXT NOT NULL,
      story_ids TEXT NOT NULL,
      task_json TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      price_stars INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OFFERED',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      paid_at INTEGER,
      delivered_at INTEGER,
      refunded_at INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      last_error TEXT
    );
    CREATE TABLE star_payments (
      telegram_payment_charge_id TEXT PRIMARY KEY,
      provider_payment_charge_id TEXT,
      bundle_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      amount_stars INTEGER NOT NULL,
      paid_at INTEGER NOT NULL,
      refunded_at INTEGER
    );
  `);
  return { db };
});

import { db } from '../src/db';
import {
  getStarsMonitoringEntitlement,
  getStarsMonitorPrice,
  initializeStarsModeSafety,
} from '../src/services/stars-mode-safety';

const originalLaunch = jest.fn(async () => undefined);
const bot = {
  launch: originalLaunch,
  telegram: {},
} as any;

function insertMonitorBundle(
  id: string,
  userId: string,
  kind: 'monitor_week' | 'monitor_month',
  price: number,
  now: number,
): void {
  db.prepare(`
    INSERT INTO star_result_bundles (
      id, user_id, chat_id, target, locale, request_kind, story_ids,
      task_json, result_count, price_stars, status, created_at, expires_at
    ) VALUES (?, ?, ?, 'story-monitoring', 'en', ?, '[]', '{}', 3, ?, 'OFFERED', ?, ?)
  `).run(id, userId, userId, kind, price, now, now + 1800);
}

function payMonitorBundle(
  id: string,
  userId: string,
  chargeId: string,
  amount: number,
  now: number,
): void {
  db.prepare(`
    INSERT INTO star_payments (
      telegram_payment_charge_id, bundle_id, user_id, amount_stars, paid_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(chargeId, id, userId, amount, now);
  db.prepare(
    'UPDATE star_result_bundles SET status = \'PAID\', paid_at = ? WHERE id = ?',
  ).run(now, id);
}

describe('Stars mode safety migrations', () => {
  beforeAll(() => {
    initializeStarsModeSafety(bot);
  });

  beforeEach(() => {
    originalLaunch.mockClear();
    db.prepare('DELETE FROM star_monitor_entitlements').run();
    db.prepare('DELETE FROM star_monitor_grants').run();
    db.prepare('DELETE FROM star_result_bundles').run();
    db.prepare('DELETE FROM star_payments').run();
    db.prepare('DELETE FROM payment_checks').run();
    db.prepare('DELETE FROM payments').run();
    db.prepare(
      `INSERT INTO bot_settings (key, value, updated_at, updated_by)
       VALUES ('payment_mode', 'stars', 0, 'migration')
       ON CONFLICT(key) DO UPDATE SET value = 'stars', updated_by = 'migration'`,
    ).run();
  });

  test('automatic mode migration defaults to Stars when no BTC invoice is active', () => {
    initializeStarsModeSafety(bot);
    const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'payment_mode'").get() as any;
    expect(row.value).toBe('stars');
  });

  test('stale BTC payment checks do not keep the bot in legacy mode', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = db.prepare(`
      INSERT INTO payments (
        user_id, invoice_amount, user_address, expires_at, paid_at
      ) VALUES ('legacy', 0.0001, 'address', ?, NULL)
    `).run(now - 60);
    db.prepare(`
      INSERT INTO payment_checks (invoice_id, next_check, check_start)
      VALUES (?, ?, ?)
    `).run(result.lastInsertRowid, now - 30, now - 3600);
    db.prepare(
      "UPDATE bot_settings SET value = 'btc', updated_by = 'migration' WHERE key = 'payment_mode'",
    ).run();

    initializeStarsModeSafety(bot);

    const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'payment_mode'").get() as any;
    expect(row.value).toBe('stars');
  });

  test('an active unpaid BTC invoice is preserved until it expires', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = db.prepare(`
      INSERT INTO payments (
        user_id, invoice_amount, user_address, expires_at, paid_at
      ) VALUES ('legacy', 0.0001, 'address', ?, NULL)
    `).run(now + 3600);
    db.prepare(`
      INSERT INTO payment_checks (invoice_id, next_check, check_start)
      VALUES (?, ?, ?)
    `).run(result.lastInsertRowid, now + 60, now);

    initializeStarsModeSafety(bot);

    const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'payment_mode'").get() as any;
    expect(row.value).toBe('btc');
  });

  test('launch wrapper retains pending Telegram payment updates', async () => {
    await bot.launch({ dropPendingUpdates: true });
    expect(originalLaunch).toHaveBeenCalledWith({ dropPendingUpdates: false });
  });

  test('new bundles are bound to the requesting user instead of a group chat', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO star_result_bundles (
        id, user_id, chat_id, target, locale, request_kind, story_ids,
        task_json, result_count, price_stars, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OFFERED', ?, ?)
    `).run(
      'group-bundle',
      '-100123',
      '-100123',
      '@target',
      'en',
      'current',
      '[1]',
      JSON.stringify({ user: { id: 456 } }),
      1,
      25,
      now,
      now + 1800,
    );

    const row = db.prepare(
      "SELECT user_id, chat_id FROM star_result_bundles WHERE id = 'group-bundle'",
    ).get() as any;
    expect(row.user_id).toBe('456');
    expect(row.chat_id).toBe('-100123');
  });

  test('weekly and monthly monitoring use the two launch prices', () => {
    expect(getStarsMonitorPrice('week')).toBe(199);
    expect(getStarsMonitorPrice('month')).toBe(499);
  });

  test('paid weekly monitoring grants three targets and completes without a download job', () => {
    const now = Math.floor(Date.now() / 1000);
    insertMonitorBundle('monitor-week', '123', 'monitor_week', 199, now);
    payMonitorBundle('monitor-week', '123', 'charge-week', 199, now);

    const entitlement = getStarsMonitoringEntitlement('123');
    expect(entitlement).toBeDefined();
    expect(entitlement?.maxTargets).toBe(3);
    expect(entitlement?.plan).toBe('monitor_week');
    expect((entitlement?.expiresAt ?? 0) - now).toBeGreaterThanOrEqual(604798);

    const bundle = db.prepare(
      "SELECT status, delivered_at FROM star_result_bundles WHERE id = 'monitor-week'",
    ).get() as any;
    expect(bundle.status).toBe('DELIVERED');
    expect(bundle.delivered_at).toBeTruthy();
  });

  test('refunding the only monitoring purchase removes its entitlement', () => {
    const now = Math.floor(Date.now() / 1000);
    insertMonitorBundle('monitor-refund', '321', 'monitor_month', 499, now);
    payMonitorBundle('monitor-refund', '321', 'charge-refund', 499, now);

    db.prepare(
      "UPDATE star_payments SET refunded_at = ? WHERE telegram_payment_charge_id = 'charge-refund'",
    ).run(now + 1);

    expect(getStarsMonitoringEntitlement('321')).toBeUndefined();
  });

  test('refunding a stacked month preserves the earlier paid week', () => {
    const now = Math.floor(Date.now() / 1000);
    insertMonitorBundle('week-first', '654', 'monitor_week', 199, now);
    payMonitorBundle('week-first', '654', 'charge-week-first', 199, now);
    const weekExpiry = getStarsMonitoringEntitlement('654')!.expiresAt;

    insertMonitorBundle('month-second', '654', 'monitor_month', 499, now + 1);
    payMonitorBundle('month-second', '654', 'charge-month-second', 499, now + 1);
    expect(getStarsMonitoringEntitlement('654')!.expiresAt).toBeGreaterThan(weekExpiry);

    db.prepare(
      "UPDATE star_payments SET refunded_at = ? WHERE telegram_payment_charge_id = 'charge-month-second'",
    ).run(now + 2);

    const remaining = getStarsMonitoringEntitlement('654');
    expect(remaining).toBeDefined();
    expect(remaining?.expiresAt).toBeGreaterThanOrEqual(weekExpiry - 1);
    expect(remaining?.expiresAt).toBeLessThanOrEqual(weekExpiry + 2);
  });
});
