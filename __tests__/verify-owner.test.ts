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

const verifyPaymentByTxid = jest.fn() as jest.Mock<any>;
jest.mock('../src/services/btc-payment', () => ({
  schedulePaymentCheck: jest.fn(),
  resumePendingChecks: jest.fn(),
  setBotInstance: jest.fn(),
  verifyPaymentByTxid,
}));

const extendPremium = jest.fn() as jest.Mock<any>;
jest.mock('../src/services/premium-service', () => ({
  isUserPremium: jest.fn().mockReturnValue(false),
  addPremiumUser: jest.fn(),
  removePremiumUser: jest.fn(),
  extendPremium,
  getPremiumDaysLeft: jest.fn().mockReturnValue(30),
  grantFreeTrial: jest.fn(),
  hasUsedFreeTrial: jest.fn(),
  calcPremiumDays: jest.fn().mockReturnValue(30),
}));

jest.mock('../src/repositories/user-repository', () => ({
  saveUser: jest.fn(),
  refreshUserUsername: jest.fn(),
  findUserById: jest.fn((id: string) => ({ telegram_id: id, language: 'en', username: `user${id}` })),
}));

// The verify rate limiter is persisted in the real database; keep the test
// independent of previous runs.
jest.mock('../src/db/effects', () => ({
  ...(jest.requireActual('../src/db/effects') as any),
  getLastVerifyAttemptFx: jest.fn(async () => null),
  updateVerifyAttemptFx: jest.fn(async () => undefined),
}));

const updatePremiumPinnedMessage = jest.fn(async () => undefined) as jest.Mock<any>;
jest.mock('../src/lib/helpers.ts', () => ({
  ...(jest.requireActual('../src/lib/helpers.ts') as any),
  updatePremiumPinnedMessage,
}));

const notifyAdmin = jest.fn();
jest.mock('../src/controllers/send-message', () => ({ notifyAdmin }));

import { handleVerify } from '../src/index';

// A legacy BTC invoice that belongs to user 555 and has just been confirmed.
const ownerInvoice = {
  id: 7,
  user_id: '555',
  invoice_amount: 0.001,
  user_address: 'addr',
  paid_amount: 0.001,
  paid_at: 1_700_000_000,
};

function makeCtx(fromId: number) {
  return {
    from: { id: fromId, language_code: 'en', username: `u${fromId}` },
    chat: { id: fromId },
    message: { text: '/verify deadbeef' },
    session: {},
    reply: jest.fn(async () => ({})),
    telegram: { sendMessage: jest.fn(async () => ({})) },
  } as any;
}

describe('/verify credits the invoice owner, never the caller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    verifyPaymentByTxid.mockResolvedValue(ownerInvoice);
  });

  test('the owner verifying their own invoice is credited and told so', async () => {
    const ctx = makeCtx(555);
    await handleVerify(ctx);
    expect(extendPremium).toHaveBeenCalledWith('555', 30);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Premium extended'));
    expect(ctx.telegram.sendMessage).not.toHaveBeenCalled();
  });

  test('a different account submitting that txid cannot take the Premium', async () => {
    const ctx = makeCtx(777);
    await handleVerify(ctx);
    const credited = extendPremium.mock.calls.map((call: any[]) => call[0]);
    expect(credited).toContain('555');
    expect(credited).not.toContain('777');
    // The owner is notified in their own chat. The caller only learns that the
    // payment was applied to the account that created the invoice.
    expect(ctx.telegram.sendMessage).toHaveBeenCalledWith('555', expect.stringContaining('Premium extended'));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('account that created this invoice'));
    expect(updatePremiumPinnedMessage).toHaveBeenCalledWith(expect.anything(), 555, '555', 30, 'en', true);
    expect(ctx.session.upgrade).toBeUndefined();
  });
});
