import { jest } from '@jest/globals';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));
jest.mock('controllers/send-active-stories', () => ({
  sendActiveStories: jest.fn(),
}));
jest.mock('controllers/download-stories', () => ({
  mapStories: jest.fn((stories: any) => stories),
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

function createInvoke(active: any[], pinned: any[] = []) {
  return jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(123), accessHash: bigInt(999), username: 'tester' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      return { stories: { stories: active } } as any;
    }
    if (query instanceof Api.stories.GetPinnedStories) {
      return { stories: pinned } as any;
    }
    if (query instanceof Api.photos.GetUserPhotos) {
      return { photos: [] } as any;
    }
    return {};
  });
}

function activeSenderMock(): any {
  const { sendActiveStories } = require('../src/controllers/send-active-stories');
  return sendActiveStories as any;
}

test('fetches pinned stories once and avoids resending after confirmed delivery', async () => {
  const row = addMonitor('user', '123', 'tester', '999', null);
  const invoke = createInvoke(
    [{ id: 1, date: 10, expireDate: 2000000000 }],
    [{ id: 2, date: 20 }],
  );
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const sendActiveStoriesMock = activeSenderMock();
  sendActiveStoriesMock
    .mockReset()
    .mockResolvedValueOnce([1])
    .mockResolvedValueOnce([2]);

  await checkSingleMonitor(row.id);

  expect(sendActiveStoriesMock).toHaveBeenCalledTimes(2);
  const [activeCall, pinnedCall] = sendActiveStoriesMock.mock.calls as any[];
  expect(activeCall[0].stories).toEqual([
    { id: 1, date: 10, expireDate: 2000000000 },
  ]);
  expect(pinnedCall[0].stories).toEqual([
    { id: 2, date: 20 },
  ]);
  expect(listSentStoryKeys(row.id, 'active')).toContain('1:10');
  expect(listSentStoryKeys(row.id, 'pinned')).toContain('2:20');

  sendActiveStoriesMock.mockClear();
  await checkSingleMonitor(row.id);

  expect(sendActiveStoriesMock).not.toHaveBeenCalled();
  const calls = invoke.mock.calls.map((call) => call[0]);
  expect(calls.some((query) => query instanceof Api.stories.GetPinnedStories)).toBe(true);
  expect(calls.some((query) => query instanceof Api.stories.GetStoriesArchive)).toBe(false);
  expect(calls.some((query) => query instanceof Api.stories.GetAllStories)).toBe(false);

  removeMonitor('user', '123');
});

test('records both active and pinned keys only after the shared story is delivered', async () => {
  const row = addMonitor('user', '456', 'tester', '999', null);
  const invoke = createInvoke(
    [{ id: 1, date: 10, expireDate: 2000000000 }],
    [{ id: 1, date: 10 }],
  );
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const sendActiveStoriesMock = activeSenderMock();
  sendActiveStoriesMock.mockReset().mockResolvedValue([1]);

  await checkSingleMonitor(row.id);

  expect(sendActiveStoriesMock).toHaveBeenCalledTimes(1);
  const [firstCall] = sendActiveStoriesMock.mock.calls as any[];
  expect(firstCall[0].stories).toEqual([
    { id: 1, date: 10, expireDate: 2000000000 },
  ]);
  expect(listSentStoryKeys(row.id, 'active')).toContain('1:10');
  expect(listSentStoryKeys(row.id, 'pinned')).toContain('1:10');

  sendActiveStoriesMock.mockClear();
  await checkSingleMonitor(row.id);
  expect(sendActiveStoriesMock).not.toHaveBeenCalled();

  removeMonitor('user', '456');
});

test('does not persist a story key when delivery throws and retries later', async () => {
  const row = addMonitor('user', '789', 'tester', '999', null);
  const invoke = createInvoke([
    { id: 9, date: 90, expireDate: 2000000000 },
  ]);
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const sendActiveStoriesMock = activeSenderMock();
  sendActiveStoriesMock
    .mockReset()
    .mockRejectedValueOnce(new Error('Telegram unavailable'))
    .mockResolvedValueOnce([9]);

  await checkSingleMonitor(row.id);
  expect(listSentStoryKeys(row.id, 'active')).not.toContain('9:90');

  await checkSingleMonitor(row.id);
  expect(sendActiveStoriesMock).toHaveBeenCalledTimes(2);
  expect(listSentStoryKeys(row.id, 'active')).toContain('9:90');

  removeMonitor('user', '789');
});

test('does not persist stories when delivery resolves with no delivered IDs', async () => {
  const row = addMonitor('user', '790', 'tester', '999', null);
  const invoke = createInvoke([
    { id: 10, date: 100, expireDate: 2000000000 },
  ]);
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const sendActiveStoriesMock = activeSenderMock();
  sendActiveStoriesMock
    .mockReset()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([10]);

  await checkSingleMonitor(row.id);
  expect(listSentStoryKeys(row.id, 'active')).not.toContain('10:100');

  await checkSingleMonitor(row.id);
  expect(sendActiveStoriesMock).toHaveBeenCalledTimes(2);
  expect(listSentStoryKeys(row.id, 'active')).toContain('10:100');

  removeMonitor('user', '790');
});

test('persists only the subset of stories confirmed delivered', async () => {
  const row = addMonitor('user', '791', 'tester', '999', null);
  const invoke = createInvoke([
    { id: 11, date: 110, expireDate: 2000000000 },
    { id: 12, date: 120, expireDate: 2000000000 },
  ]);
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const sendActiveStoriesMock = activeSenderMock();
  sendActiveStoriesMock.mockReset().mockResolvedValue([11]);

  await checkSingleMonitor(row.id);
  expect(listSentStoryKeys(row.id, 'active')).toContain('11:110');
  expect(listSentStoryKeys(row.id, 'active')).not.toContain('12:120');

  removeMonitor('user', '791');
});
