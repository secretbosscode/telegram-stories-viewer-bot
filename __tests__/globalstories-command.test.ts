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

const handleNewTask = jest.fn();
jest.mock('../src/services/queue-manager', () => ({ handleNewTask }));

jest.mock('../src/services/premium-service', () => ({
  isUserPremium: (id: string) => id === '1',
}));

import { handleGlobalStories } from '../src/controllers/global-stories';
import { IContextBot } from '../src/config/context-interface';
import { t } from '../src/lib/i18n';

describe('handleGlobalStories', () => {
  test('requires premium access', async () => {
    const ctx = { from: { id: 2, language_code: 'en' }, chat: { id: 2 } } as unknown as IContextBot;
    await handleGlobalStories(ctx);
    expect(sendTemporaryMessage).toHaveBeenCalledWith(bot, 2, t('en', 'feature.requiresPremium'));
    expect(handleNewTask).not.toHaveBeenCalled();
  });

  test('queues global stories for premium user', async () => {
    const ctx = { from: { id: 1, language_code: 'en' }, chat: { id: 1 } } as unknown as IContextBot;
    await handleGlobalStories(ctx);
    expect(handleNewTask).toHaveBeenCalledWith(
      expect.objectContaining({ storyRequestType: 'global' })
    );
  });
});
