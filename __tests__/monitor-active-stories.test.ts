import { jest } from '@jest/globals';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
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
import { addMonitor, removeMonitor, listSentStoryKeys } from '../src/db';
import { checkSingleMonitor } from '../src/services/monitor-service';
import { Api } from 'telegram';
import bigInt from 'big-integer';

test('fetches pinned stories once and avoids resending on retries', async () => {
  const row = addMonitor('user', '123', 'tester', '999', null);

  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(123), accessHash: bigInt(999), username: 'tester' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      return {
        stories: {
          stories: [{ id: 1, date: 10, expireDate: 2000000000 }],
        },
      } as any;
    }
    if (query instanceof Api.stories.GetPinnedStories) {
      return {
        stories: [{ id: 2, date: 20 }],
      } as any;
    }
    if (query instanceof Api.photos.GetUserPhotos) {
      return { photos: [] } as any;
    }
    return {};
  });

  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const { sendActiveStories } = require('../src/controllers/send-active-stories');
  const sendActiveStoriesMock = sendActiveStories as jest.Mock;

  sendActiveStoriesMock.mockClear();

  await checkSingleMonitor(row.id);

  expect(sendActiveStoriesMock).toHaveBeenCalledTimes(2);
  const [activeCall, pinnedCall] = sendActiveStoriesMock.mock.calls as any[];
  expect(activeCall[0].stories).toEqual([
    { id: 1, date: 10, expireDate: 2000000000 },
  ]);
  expect(pinnedCall[0].stories).toEqual([
    { id: 2, date: 20 },
  ]);
  expect(listSentStoryKeys(row.id, 'pinned')).toContain('2:20');

  sendActiveStoriesMock.mockClear();

  await checkSingleMonitor(row.id);

  expect(sendActiveStoriesMock).not.toHaveBeenCalled();
  const calls = invoke.mock.calls.map((c) => c[0]);
  expect(calls.some((q) => q instanceof Api.stories.GetPinnedStories)).toBe(true);
  expect(calls.some((q) => q instanceof Api.stories.GetStoriesArchive)).toBe(false);
  expect(calls.some((q) => q instanceof Api.stories.GetAllStories)).toBe(false);

  removeMonitor('user', '123');
});
