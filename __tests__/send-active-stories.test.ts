import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  BOT_TOKEN: 'token',
  LOG_FILE: '/tmp/test.log',
}));

const sendTemporaryMessage = jest.fn(async () => {});
jest.mock('lib', () => ({
  ...(jest.requireActual('../src/lib/index.ts') as any),
  sendTemporaryMessage,
}));

const notifyAdmin = jest.fn();
jest.mock('controllers/send-message', () => ({ notifyAdmin }));

jest.mock('controllers/download-stories', () => ({
  downloadStories: jest.fn(() => Promise.resolve({ successCount: 1, failed: [], skipped: [] })),
  mapStories: jest.fn((s: any) => s),
}));

jest.mock('config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));

const bot = { telegram: { sendMediaGroup: jest.fn(), sendMessage: jest.fn() } } as any;
jest.mock('index', () => ({ bot }));

jest.mock('lib/i18n', () => ({ t: () => '' }));

import { sendActiveStories } from '../src/controllers/send-active-stories';
import { MappedStoryItem, SendStoriesArgs } from '../src/types';

describe('sendActiveStories single story caption', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('includes active story info in caption for single story', async () => {
    const story: MappedStoryItem = {
      id: 1,
      media: {} as any,
      mediaType: 'photo',
      date: new Date(),
      buffer: Buffer.from('x'),
      bufferSize: 1,
      caption: 'Original',
    };
    const args: SendStoriesArgs = {
      stories: [story],
      task: {
        chatId: '1',
        link: 'user',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
      } as any,
    };

    await sendActiveStories(args);

    expect(bot.telegram.sendMediaGroup).toHaveBeenCalledTimes(1);
    const media = (bot.telegram.sendMediaGroup as jest.Mock).mock.calls[0][1] as any[];
    expect(media[0].caption).toBe('Original\n\nActive story from user');
    expect(sendTemporaryMessage).toHaveBeenCalledTimes(2);
  });
});

