import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  BOT_TOKEN: 'token',
  LOG_FILE: '/tmp/test.log',
}));

const sendParticularStory = jest.fn();
jest.mock('../src/controllers/send-particular-story', () => ({ sendParticularStory }));
const sendPaginatedStories = jest.fn();
jest.mock('../src/controllers/send-paginated-stories', () => ({ sendPaginatedStories }));
const sendActiveStories = jest.fn();
jest.mock('../src/controllers/send-active-stories', () => ({ sendActiveStories }));
const sendPinnedStories = jest.fn();
jest.mock('../src/controllers/send-pinned-stories', () => ({ sendPinnedStories }));
jest.mock('../src/controllers/download-stories', () => ({ mapStories: jest.fn((s: any) => s) }));

const sendTemporaryMessage = jest.fn();
jest.mock('../src/lib/helpers.ts', () => ({
  ...(jest.requireActual('../src/lib/helpers.ts') as any),
  sendTemporaryMessage,
}));

const bot = { telegram: { sendMessage: jest.fn() } } as any;
jest.mock('../src/index.ts', () => ({ bot }));

import { sendStoriesFx } from '../src/controllers/send-stories';
import { SendStoriesFxParams } from '../src/types';

describe('sendStoriesFx', () => {
  test('uses sendTemporaryMessage on success', async () => {
    const params: SendStoriesFxParams = {
      particularStory: {} as any,
      task: {
        chatId: '1',
        link: 'user',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
      },
    } as any;

    await sendStoriesFx(params);

    expect(sendParticularStory).toHaveBeenCalled();
    expect(sendTemporaryMessage).toHaveBeenCalledWith(
      bot,
      '1',
      '🎉 Download for user completed!'
    );
    expect(bot.telegram.sendMessage).not.toHaveBeenCalledWith(
      '1',
      expect.stringContaining('No public stories')
    );
  });
});
