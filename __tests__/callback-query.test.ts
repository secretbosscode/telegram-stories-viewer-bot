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
  isUserPremium: jest.fn().mockReturnValue(true),
  addPremiumUser: jest.fn(),
  removePremiumUser: jest.fn(),
  extendPremium: jest.fn(),
  getPremiumDaysLeft: jest.fn().mockReturnValue(0),
}));

jest.mock('../src/repositories/user-repository', () => ({ saveUser: jest.fn() }));

const handleNewTask = jest.fn();
jest.mock('../src/services/queue-manager', () => ({ handleNewTask }));

import { handleCallbackQuery } from '../src/index';

describe('callback query handler', () => {
  test('removes inline keyboard after handling', async () => {
    const ctx = {
      callbackQuery: { data: 'user&[1]' },
      from: { id: 1, language_code: 'en' },
      editMessageReplyMarkup: jest.fn(),
      answerCbQuery: jest.fn(),
    } as any;

    await handleCallbackQuery(ctx);

    expect(handleNewTask).toHaveBeenCalled();
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
  });

  test('only removes pressed button from keyboard', async () => {
    const ctx = {
      callbackQuery: {
        data: 'user&[2]',
        message: {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '1', callback_data: 'user&[1]' },
                { text: '2', callback_data: 'user&[2]' },
              ],
            ],
          },
        },
      },
      from: { id: 1, language_code: 'en' },
      editMessageReplyMarkup: jest.fn(),
      answerCbQuery: jest.fn(),
    } as any;

    await handleCallbackQuery(ctx);

    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({
      inline_keyboard: [[{ text: '1', callback_data: 'user&[1]' }]],
    });
  });
});
