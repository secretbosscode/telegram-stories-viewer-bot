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
  setStarsMonitorPrice,
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
  maxTargets = 3,
): void {
  db.prepare(`
    INSERT INTO star_result_bundles (
      id, user_id, chat_id, target, locale, request_kind, story_ids,
      task_json, result_count, price_stars, status, created_at, expires_at
    ) VALUES (?, ?, ?, 'story-monitoring', 'en', ?, '[]', '{}', ?, ?, 'OFFERED', ?, ?)
  `).run(id, userId, userId, kind, maxTargets, price, now, now + 1800);
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
    db.prepare('DELETE FROM monitors').run();
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM payment_checks').run();
    db.prepare('DELETE FROM payments').run();
    db.prepare(
      `INSERT INTO bot_settings (key, value, updated_at, updated_by)
       VALUES ('payment_mode', 'stars', 0, 'migration')
       ON CONFLICT(key) DO UPDATE SET value = 'stars', updated_by = 'migration'`,
    ).run();
    db.prepare("UPDATE bot_settings SET value = '199' WHERE key = 'stars_monitor_week_price'").run();
    db.prepare("UPDATE bot_settings SET value = '499' WHERE key = 'stars_monitor_month_price'").run();
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

  test('weekly and monthly monitoring prices are mutable in SQLite', () => {
    expect(getStarsMonitorPrice('week')).toBe(199);
    expect(getStarsMonitorPrice('month')).toBe(499);
    expect(setStarsMonitorPrice('week', 225, 'admin')).toBe(true);
    expect(setStarsMonitorPrice('month', 525, 'admin')).toBe(true);
    expect(getStarsMonitorPrice('week')).toBe(225);
    expect(getStarsMonitorPrice('month')).toBe(525);
  });

  test('paid weekly monitoring freezes the advertised target limit', () => {
    const now = Math.floor(Date.now() / 1000);
    insertMonitorBundle('monitor-week', '123', 'monitor_week', 199, now, 4);
    payMonitorBundle('monitor-week', '123', 'charge-week', 199, now);

    const entitlement = getStarsMonitoringEntitlement('123');
    expect(entitlement).toBeDefined();
    expect(entitlement?.maxTargets).toBe(4);
    expect(entitlement?.plan).toBe('monitor_week');
    expect((entitlement?.expiresAt ?? 0) - now).toBeGreaterThanOrEqual(604798);

    const grant = db.prepare(
      "SELECT max_targets, plan FROM star_monitor_grants WHERE bundle_id = 'monitor-week'",
    ).get() as any;
    expect(grant.max_targets).toBe(4);
    expect(grant.plan).toBe('monitor_week');

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

  test('refunding a stacked month restores the earlier week time, plan, and limit', () => {
    const now = Math.floor(Date.now() / 1000);
    insertMonitorBundle('week-first', '654', 'monitor_week', 199, now, 3);
    payMonitorBundle('week-first', '654', 'charge-week-first', 199, now);
    const weekEntitlement = getStarsMonitoringEntitlement('654')!;

    insertMonitorBundle('month-second', '654', 'monitor_month', 499, now + 1, 5);
    payMonitorBundle('month-second', '654', 'charge-month-second', 499, now + 1);
    const stacked = getStarsMonitoringEntitlement('654')!;
    expect(stacked.expiresAt).toBeGreaterThan(weekEntitlement.expiresAt);
    expect(stacked.maxTargets).toBe(5);
    expect(stacked.plan).toBe('monitor_month');

    db.prepare(
      "UPDATE star_payments SET refunded_at = ? WHERE telegram_payment_charge_id = 'charge-month-second'",
    ).run(now + 2);

    const remaining = getStarsMonitoringEntitlement('654');
    expect(remaining).toBeDefined();
    expect(remaining?.expiresAt).toBeGreaterThanOrEqual(weekEntitlement.expiresAt - 1);
    expect(remaining?.expiresAt).toBeLessThanOrEqual(weekEntitlement.expiresAt + 2);
    expect(remaining?.maxTargets).toBe(3);
    expect(remaining?.plan).toBe('monitor_week');
  });



  test('refunding an expired earlier grant does not shorten a later renewal', () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredWeekPaidAt = now - (8 * 24 * 60 * 60);
    insertMonitorBundle('expired-week', 'renewed-user', 'monitor_week', 199, expiredWeekPaidAt, 3);
    payMonitorBundle('expired-week', 'renewed-user', 'expired-week-charge', 199, expiredWeekPaidAt);
    db.prepare(
      "UPDATE star_monitor_entitlements SET expires_at = ? WHERE user_id = 'renewed-user'",
    ).run(expiredWeekPaidAt + (7 * 24 * 60 * 60));

    insertMonitorBundle('later-month', 'renewed-user', 'monitor_month', 499, now, 5);
    payMonitorBundle('later-month', 'renewed-user', 'later-month-charge', 499, now);
    const beforeRefund = getStarsMonitoringEntitlement('renewed-user')!;

    db.prepare(
      "UPDATE star_payments SET refunded_at = ? WHERE telegram_payment_charge_id = 'expired-week-charge'",
    ).run(now + 1);

    const afterRefund = getStarsMonitoringEntitlement('renewed-user')!;
    expect(afterRefund.expiresAt).toBe(beforeRefund.expiresAt);
    expect(afterRefund.plan).toBe('monitor_month');
    expect(afterRefund.maxTargets).toBe(5);
  });

  test('monitor target limit is enforced atomically by SQLite', () => {
    const now = Math.floor(Date.now() / 1000);
    insertMonitorBundle('atomic-limit', 'atomic-user', 'monitor_week', 199, now, 1);
    payMonitorBundle('atomic-limit', 'atomic-user', 'atomic-charge', 199, now);

    db.prepare(
      `INSERT INTO monitors (telegram_id, target_id, target_username, created_at)
       VALUES ('atomic-user', '1', 'first', ?)`
    ).run(now);

    expect(() => db.prepare(
      `INSERT INTO monitors (telegram_id, target_id, target_username, created_at)
       VALUES ('atomic-user', '2', 'second', ?)`
    ).run(now + 1)).toThrow(/STAR_MONITOR_LIMIT/);

    const row = db.prepare(
      "SELECT COUNT(*) AS count FROM monitors WHERE telegram_id = 'atomic-user'"
    ).get() as any;
    expect(Number(row.count)).toBe(1);
  });

  test('refunding Stars monitoring preserves monitors for active Premium users', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO users (telegram_id, is_premium, premium_until)
       VALUES ('premium-monitor', 1, ?)`
    ).run(now + 86400);
    insertMonitorBundle('premium-refund', 'premium-monitor', 'monitor_week', 199, now, 1);
    payMonitorBundle('premium-refund', 'premium-monitor', 'premium-refund-charge', 199, now);
    db.prepare(
      `INSERT INTO monitors (telegram_id, target_id, target_username, created_at)
       VALUES ('premium-monitor', '1', 'kept', ?)`
    ).run(now);

    db.prepare(
      "UPDATE star_payments SET refunded_at = ? WHERE telegram_payment_charge_id = 'premium-refund-charge'"
    ).run(now + 1);

    expect(getStarsMonitoringEntitlement('premium-monitor')).toBeUndefined();
    const row = db.prepare(
      "SELECT COUNT(*) AS count FROM monitors WHERE telegram_id = 'premium-monitor'"
    ).get() as any;
    expect(Number(row.count)).toBe(1);
  });
});
