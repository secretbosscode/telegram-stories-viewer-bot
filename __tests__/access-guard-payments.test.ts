import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  BOT_TOKEN: 'token',
  LOG_FILE: '/tmp/test.log',
  isDevEnv: false,
}));
jest.mock('../src/services/monitor-service', () => ({
  addProfileMonitor: jest.fn(),
  removeProfileMonitor: jest.fn(),
  userMonitorCount: jest.fn(),
  listUserMonitors: jest.fn(),
  startMonitorLoop: jest.fn(),
  stopMonitorLoop: jest.fn(),
  formatMonitorTarget: jest.fn(),
  refreshMonitorUsername: jest.fn(),
  forceCheckMonitors: jest.fn(),
  CHECK_INTERVAL_HOURS: 1,
  MAX_MONITORS_PER_USER: 1,
}));
jest.mock('../src/services/btc-payment', () => ({
  schedulePaymentCheck: jest.fn(),
  resumePendingChecks: jest.fn(),
  setBotInstance: jest.fn(),
  verifyPaymentByTxid: jest.fn(),
}));
jest.mock('../src/services/premium-service', () => ({
  isUserPremium: jest.fn().mockReturnValue(false),
  addPremiumUser: jest.fn(),
  removePremiumUser: jest.fn(),
  extendPremium: jest.fn(),
  getPremiumDaysLeft: jest.fn().mockReturnValue(0),
  grantFreeTrial: jest.fn(),
  hasUsedFreeTrial: jest.fn(),
  calcPremiumDays: jest.fn(),
}));
jest.mock('../src/repositories/user-repository', () => ({
  saveUser: jest.fn(),
  refreshUserUsername: jest.fn(),
  findUserById: jest.fn(),
}));

import { accessGuard } from '../src/index';
import { blockUser, unblockUser } from '../src/db';

const BANNED = 909090;

afterAll(() => unblockUser(String(BANNED)));

function run(update: Record<string, unknown>) {
  const next = jest.fn(async () => undefined);
  const ctx = { from: { id: BANNED, is_bot: false }, reply: jest.fn(async () => ({})), ...update } as any;
  return accessGuard(ctx, next).then(() => next);
}

test('a banned user is dropped for ordinary updates', async () => {
  blockUser(String(BANNED));
  const next = await run({ updateType: 'message', message: { text: 'hello' } });
  expect(next).not.toHaveBeenCalled();
});

test('a successful_payment from a banned user still reaches the payment handler', async () => {
  blockUser(String(BANNED));
  const next = await run({
    updateType: 'message',
    message: { successful_payment: { telegram_payment_charge_id: 'c', invoice_payload: 'b' } },
  });
  expect(next).toHaveBeenCalledTimes(1);
});

test('a pre_checkout_query from a banned user reaches the handler that will refuse it', async () => {
  blockUser(String(BANNED));
  const next = await run({ updateType: 'pre_checkout_query', preCheckoutQuery: { id: '1' } });
  expect(next).toHaveBeenCalledTimes(1);
});
