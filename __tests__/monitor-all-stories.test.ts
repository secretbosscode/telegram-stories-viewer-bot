import { jest } from '@jest/globals';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));
jest.mock('controllers/send-active-stories', () => ({
  sendActiveStories: jest.fn(),
}));
jest.mock('controllers/send-pinned-stories', () => ({
  sendPinnedStories: jest.fn(),
}));
jest.mock('controllers/send-archived-stories', () => ({
  sendArchivedStories: jest.fn(),
}));
jest.mock('controllers/send-global-stories', () => ({
  sendGlobalStories: jest.fn(),
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

test('dispatches all story types without duplication', async () => {
  const row = addMonitor('user', '123', 'tester', '999', null);

  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(123), accessHash: bigInt(999), username: 'tester' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      return { stories: { stories: [{ id: 1, date: 10, expireDate: 2000000000 }] } } as any;
    }
    if (query instanceof Api.stories.GetPinnedStories) {
      return { stories: [{ id: 2, date: 10, expireDate: 2000000000 }] } as any;
    }
    if (query instanceof Api.stories.GetStoriesArchive) {
      return { stories: [{ id: 3, date: 10, expireDate: 2000000000 }] } as any;
    }
    if (query instanceof Api.stories.GetAllStories) {
      return { stories: [{ id: 4, date: 10, expireDate: 2000000000 }] } as any;
    }
    if (query instanceof Api.photos.GetUserPhotos) {
      return { photos: [] } as any;
    }
    return {};
  });

  ;(Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const { sendActiveStories } = require('../src/controllers/send-active-stories');
  const { sendPinnedStories } = require('../src/controllers/send-pinned-stories');
  const { sendArchivedStories } = require('../src/controllers/send-archived-stories');
  const { sendGlobalStories } = require('../src/controllers/send-global-stories');

  await checkSingleMonitor(row.id);
  await checkSingleMonitor(row.id);

  expect(sendActiveStories).toHaveBeenCalledTimes(1);
  expect(sendPinnedStories).toHaveBeenCalledTimes(1);
  expect(sendArchivedStories).toHaveBeenCalledTimes(1);
  expect(sendGlobalStories).toHaveBeenCalledTimes(1);

  removeMonitor('user', '123');
});
