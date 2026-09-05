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

import { handleMyChatMember } from '../src/index';
import { hasBlockedBot, setBotBlocked } from '../src/db';

const CHAT = '424242';

function update(status: string, type = 'private') {
  return {
    myChatMember: {
      chat: { id: Number(CHAT), type },
      new_chat_member: { status },
    },
  } as any;
}

afterAll(() => setBotBlocked(CHAT, false));

test('a user blocking the bot pauses deliveries, and unblocking resumes them', async () => {
  await handleMyChatMember(update('kicked'));
  expect(hasBlockedBot(CHAT)).toBe(true);

  await handleMyChatMember(update('member'));
  expect(hasBlockedBot(CHAT)).toBe(false);
});

test('leaving or being removed from a group is treated the same way', async () => {
  await handleMyChatMember(update('left', 'supergroup'));
  expect(hasBlockedBot(CHAT)).toBe(true);

  await handleMyChatMember(update('administrator', 'supergroup'));
  expect(hasBlockedBot(CHAT)).toBe(false);
});
