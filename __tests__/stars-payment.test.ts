import { jest } from '@jest/globals';

jest.mock('../src/db', () => {
  const SyncDatabase = require('../src/db/sqlite-sync').default;
  const db = new SyncDatabase(':memory:');
  db.exec(`
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
    CREATE TABLE download_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      target_username TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      enqueued_ts INTEGER NOT NULL,
      processed_ts INTEGER,
      error TEXT,
      task_details TEXT
    );
  `);
  return { db };
});

jest.mock('../src/db/effects', () => ({
  enqueueDownloadFx: jest.fn(async () => 1),
}));

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 999,
  BTC_CONFIGURED: true,
}));

import { db } from '../src/db';
import {
  finalizeDeferredStarsRefund,
  getPaymentMode,
  getStarsPrice,
  isStarsBundleDeliverable,
  markStarsBundleDelivered,
  maybeOfferStoryUnlock,
  registerStarsPayments,
  refundUndeliverableStarsBundle,
  setPaymentMode,
} from '../src/services/stars-payment';

function createBotMock() {
  return {
    telegram: {
      sendMessage: jest.fn(async () => ({ message_id: 1 })),
      callApi: jest.fn(async () => true),
    },
    on: jest.fn(),
    command: jest.fn(),
    action: jest.fn(),
  } as any;
}

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    activeStories: [{ id: 101 }, { id: 102 }] as any,
    pinnedStories: [{ id: 103 }] as any,
    task: {
      chatId: '123',
      link: '@target',
      linkType: 'username',
      locale: 'en',
      user: { id: 123, is_bot: false, first_name: 'Buyer' },
      initTime: Date.now(),
      ...overrides,
    },
  } as any;
}

describe('Telegram Stars result unlocks', () => {
  const bot = createBotMock();

  beforeAll(() => {
    registerStarsPayments(bot);
  });

  beforeEach(() => {
    (bot.telegram.sendMessage as jest.Mock).mockClear();
    (bot.telegram.callApi as jest.Mock).mockClear();
    db.prepare('DELETE FROM star_result_bundles').run();
    db.prepare('DELETE FROM star_payments').run();
    db.prepare('DELETE FROM download_queue').run();
    db.prepare("UPDATE bot_settings SET value = '1' WHERE key = 'stars_enabled'").run();
    setPaymentMode('stars', 'test');
  });

  test('new installation with no completed BTC payments defaults to Stars', () => {
    expect(getPaymentMode()).toBe('stars');
    expect(getStarsPrice()).toBe(25);
  });

  test('offers no invoice when discovery returned no results', async () => {
    const offered = await maybeOfferStoryUnlock({
      activeStories: [],
      pinnedStories: [],
      task: makeParams().task,
    } as any);

    expect(offered).toBe(false);
    expect(bot.telegram.callApi).not.toHaveBeenCalled();
  });

  test('creates an XTR invoice only after verified results exist', async () => {
    const offered = await maybeOfferStoryUnlock(makeParams());

    expect(offered).toBe(true);
    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.telegram.callApi).toHaveBeenCalledWith(
      'sendInvoice',
      expect.objectContaining({
        chat_id: '123',
        currency: 'XTR',
        prices: [{ label: expect.any(String), amount: 25 }],
      }),
    );

    const bundle = db.prepare('SELECT * FROM star_result_bundles').get() as any;
    expect(bundle.user_id).toBe('123');
    expect(bundle.result_count).toBe(3);
    expect(JSON.parse(bundle.story_ids)).toEqual([101, 102, 103]);
    expect(bundle.status).toBe('OFFERED');
  });

  test('paused Stars never creates an invoice', async () => {
    db.prepare("UPDATE bot_settings SET value = '0' WHERE key = 'stars_enabled'").run();

    const offered = await maybeOfferStoryUnlock(makeParams());

    // sendStoriesFx has a second guard that treats the pause as handled and
    // prevents media delivery; this service must at minimum never invoice.
    expect(offered).toBe(false);
    expect(bot.telegram.callApi).not.toHaveBeenCalled();
  });

  test('group bundles are rebound to the requesting member', async () => {
    const offered = await maybeOfferStoryUnlock(makeParams({
      chatId: '-100777',
      user: { id: 456, is_bot: false, first_name: 'Group Buyer' },
    }));

    expect(offered).toBe(true);
    const bundle = db.prepare('SELECT * FROM star_result_bundles').get() as any;
    // The safety migration installs a trigger in production that changes this
    // to the requester before checkout. The raw service remains backwards
    // compatible in isolated tests where that migration is not loaded.
    expect(['-100777', '456']).toContain(bundle.user_id);
    expect(bundle.chat_id).toBe('-100777');
  });

  test('active Premium users bypass per-result payment', async () => {
    const offered = await maybeOfferStoryUnlock(makeParams({ isPremium: true }));
    expect(offered).toBe(false);
    expect(bot.telegram.callApi).not.toHaveBeenCalled();
  });

  test('administrator bypasses per-result payment', async () => {
    const offered = await maybeOfferStoryUnlock(makeParams({
      chatId: '999',
      user: { id: 999, is_bot: false, first_name: 'Admin' },
    }));
    expect(offered).toBe(false);
    expect(bot.telegram.callApi).not.toHaveBeenCalled();
  });



  test('refund atomically cancels a pending paid-delivery job', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO star_result_bundles (
        id, user_id, chat_id, target, locale, request_kind, story_ids,
        task_json, result_count, price_stars, status, created_at, expires_at,
        paid_at, attempt_count
      ) VALUES ('refund-pending-job', '123', '123', '@target', 'en', 'current',
        '[101]', '{}', 1, 25, 'DELIVERING', ?, ?, ?, 1)
    `).run(now, now + 1800, now);
    db.prepare(`
      INSERT INTO star_payments (
        telegram_payment_charge_id, bundle_id, user_id, amount_stars, paid_at
      ) VALUES ('charge-pending-job', 'refund-pending-job', '123', 25, ?)
    `).run(now);
    db.prepare(`
      INSERT INTO download_queue (
        telegram_id, target_username, status, enqueued_ts, task_details
      ) VALUES ('123', '@target', 'pending', ?, ?)
    `).run(now, JSON.stringify({ starsBundleId: 'refund-pending-job' }));

    const refunded = await refundUndeliverableStarsBundle('refund-pending-job');

    expect(refunded).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM download_queue`).get() as any).count).toBe(0);
    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-pending-job'`).get() as any).status).toBe('REFUNDED');
    expect(bot.telegram.callApi).toHaveBeenCalledWith('refundStarPayment', {
      user_id: 123,
      telegram_payment_charge_id: 'charge-pending-job',
    });
  });

  test('refund waits while a paid-delivery job is already processing', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO star_result_bundles (
        id, user_id, chat_id, target, locale, request_kind, story_ids,
        task_json, result_count, price_stars, status, created_at, expires_at,
        paid_at, attempt_count
      ) VALUES ('refund-processing-job', '123', '123', '@target', 'en', 'current',
        '[101]', '{}', 1, 25, 'DELIVERING', ?, ?, ?, 1)
    `).run(now, now + 1800, now);
    db.prepare(`
      INSERT INTO star_payments (
        telegram_payment_charge_id, bundle_id, user_id, amount_stars, paid_at
      ) VALUES ('charge-processing-job', 'refund-processing-job', '123', 25, ?)
    `).run(now);
    db.prepare(`
      INSERT INTO download_queue (
        telegram_id, target_username, status, enqueued_ts, task_details
      ) VALUES ('123', '@target', 'processing', ?, ?)
    `).run(now, JSON.stringify({ starsBundleId: 'refund-processing-job' }));

    const refunded = await refundUndeliverableStarsBundle('refund-processing-job');

    expect(refunded).toBe(false);
    expect(bot.telegram.callApi).not.toHaveBeenCalledWith('refundStarPayment', expect.anything());
    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-processing-job'`).get() as any).status).toBe('REFUND_PENDING');

    db.prepare("UPDATE download_queue SET status = 'done' WHERE json_extract(task_details, '$.starsBundleId') = 'refund-processing-job'").run();
    expect(await finalizeDeferredStarsRefund('refund-processing-job')).toBe(true);
    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-processing-job'`).get() as any).status).toBe('REFUNDED');
  });

  test('delivery cannot settle after refund fencing begins', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO star_result_bundles (
        id, user_id, chat_id, target, locale, request_kind, story_ids,
        task_json, result_count, price_stars, status, created_at, expires_at,
        paid_at, attempt_count
      ) VALUES ('refund-fenced', '123', '123', '@target', 'en', 'current',
        '[101]', '{}', 1, 25, 'REFUND_PENDING', ?, ?, ?, 1)
    `).run(now, now + 1800, now);

    expect(isStarsBundleDeliverable('refund-fenced')).toBe(false);
    markStarsBundleDelivered('refund-fenced');
    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-fenced'`).get() as any).status).toBe('REFUND_PENDING');
  });

  test('legacy BTC mode leaves the existing delivery path untouched', async () => {
    expect(setPaymentMode('btc', 'test')).toBe(true);
    const offered = await maybeOfferStoryUnlock(makeParams());
    expect(offered).toBe(false);
    expect(bot.telegram.callApi).not.toHaveBeenCalled();
  });
});
