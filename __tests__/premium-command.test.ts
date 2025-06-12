import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  BOT_TOKEN: 'token',
  LOG_FILE: '/tmp/test.log',
}));

const sendTemporaryMessage = jest.fn();
jest.mock('../src/lib/helpers.ts', () => ({
  ...(jest.requireActual('../src/lib/helpers.ts') as any),
  sendTemporaryMessage,
}));

const bot = { telegram: { sendMessage: jest.fn() } } as any;
jest.mock('../src/index.ts', () => ({ bot }));

jest.mock('../src/services/premium-service', () => ({
  isUserPremium: jest.fn().mockReturnValue(true),
}));

jest.mock('../src/services/monitor-service', () => ({ MAX_MONITORS_PER_USER: 5 }));

import { handlePremium } from '../src/controllers/premium';
import { IContextBot } from '../src/config/context-interface';
import { t } from '../src/lib/i18n';

describe('handlePremium', () => {
  test('sends temporary message for existing premium users', async () => {
    const ctx = { from: { id: 1 }, chat: { id: 1 } } as unknown as IContextBot;

    await handlePremium(ctx);

    expect(sendTemporaryMessage).toHaveBeenCalledWith(bot, 1, t('en', 'premium.already'));
  });
});
