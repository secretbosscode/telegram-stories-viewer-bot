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
      paid_at INTEGER
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
  getPaymentMode,
  getStarsPrice,
  maybeOfferStoryUnlock,
  registerStarsPayments,
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

  test('active Premium users bypass per-result payment', async () => {
    const offered = await maybeOfferStoryUnlock(makeParams({ isPremium: true }));
    expect(offered).toBe(false);
    expect(bot.telegram.callApi).not.toHaveBeenCalled();
  });

  test('administrator bypasses per-result payment', async () => {
    const offered = await maybeOfferStoryUnlock(makeParams({ chatId: '999' }));
    expect(offered).toBe(false);
    expect(bot.telegram.callApi).not.toHaveBeenCalled();
  });

  test('legacy BTC mode leaves the existing delivery path untouched', async () => {
    expect(setPaymentMode('btc', 'test')).toBe(true);
    const offered = await maybeOfferStoryUnlock(makeParams());
    expect(offered).toBe(false);
    expect(bot.telegram.callApi).not.toHaveBeenCalled();
  });
});
