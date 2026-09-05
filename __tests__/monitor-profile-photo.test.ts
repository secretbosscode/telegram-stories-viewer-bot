import { jest } from '@jest/globals';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));
jest.mock('../src/index', () => ({
  bot: {
    telegram: {
      sendPhoto: jest.fn(),
      sendVideo: jest.fn(),
      sendMessage: jest.fn(),
    },
  },
}));
jest.mock('controllers/send-active-stories', () => ({
  sendActiveStories: jest.fn(),
}));
jest.mock('controllers/download-stories', () => ({
  mapStories: jest.fn((s: any) => s),
}));
jest.mock('../src/config/env-config', () => ({ BOT_ADMIN_ID: 0, LOG_FILE: '/tmp/test.log' }));
jest.mock('lib/i18n', () => ({
  t: () => '',
}));

import { Userbot } from '../src/config/userbot';
import { addMonitor, removeMonitor } from '../src/db';
import { checkSingleMonitor } from '../src/services/monitor-service';
import { Api } from 'telegram';
import bigInt from 'big-integer';

test('sends profile photo when changed', async () => {
  const row = addMonitor('user', '123', 'tester', '999', null);
  let photoId: number | null = 1;
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(123), accessHash: bigInt(999), username: 'tester' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      return { stories: { stories: [] } } as any;
    }
    if (query instanceof Api.photos.GetUserPhotos) {
      return {
        photos: photoId ? [{ id: photoId, videoSizes: [] }] : [],
      } as any;
    }
    return null;
  });
  const downloadMedia = jest
    .fn<(...args: any[]) => Promise<Buffer>>()
    .mockResolvedValue(Buffer.from('img'));
  (Userbot.getInstance as any).mockResolvedValue({ invoke, downloadMedia } as any);

  const { bot } = require('../src/index');

  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(1);

  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(1);

  photoId = 2;
  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(2);

  // An empty GetUserPhotos result is not proof of deletion: a privacy change, a
  // block, or a deleted account returns the same thing. Two consecutive empty
  // reads are required before telling the subscriber the photo was removed, so
  // the first one is silent.
  photoId = null;
  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(0);
  expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(2);

  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
  expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(2);

  // Once reported, it is not reported again.
  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);

  removeMonitor('user', '123');
});
