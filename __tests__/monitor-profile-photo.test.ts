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

import fs from 'fs';
import { Userbot } from '../src/config/userbot';
import { addMonitor, removeMonitor, db } from '../src/db';
import { checkSingleMonitor } from '../src/services/monitor-service';
import { listArchivedPhotos } from '../src/services/profile-photo-archive';
import { Api } from 'telegram';
import bigInt from 'big-integer';

test('sends profile photo when changed, archives history and reports deletions', async () => {
  db.prepare('DELETE FROM monitor_profile_photos WHERE target_id = ?').run('123');
  const row = addMonitor('user', '123', 'tester', '999', null);
  // photos.GetUserPhotos returns the whole history, newest first. Changing an
  // avatar prepends; deleting removes an entry.
  let history: number[] = [1];
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(123), accessHash: bigInt(999), username: 'tester' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      return { stories: { stories: [] } } as any;
    }
    if (query instanceof Api.photos.GetUserPhotos) {
      return { photos: history.map((id) => ({ id, videoSizes: [] })) } as any;
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
  // The first sighting is archived to disk.
  const archived = listArchivedPhotos('123');
  expect(archived.map((p) => p.photo_id)).toEqual(['1']);
  expect(archived[0].file_path && fs.existsSync(archived[0].file_path)).toBe(true);

  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(1);

  // A new avatar: the old one stays in history, so only the change is sent.
  history = [2, 1];
  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(2);
  expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(0);

  // The old avatar is deleted from history: the archived copy is sent once,
  // with the deletion caption, and the row is marked deleted.
  history = [2];
  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(3);
  const deletedCall = (bot.telegram.sendPhoto as jest.Mock).mock.calls[2] as any[];
  expect(deletedCall[1]).toEqual({ source: expect.stringContaining('/profile-archive/123/1.jpg') });
  expect(listArchivedPhotos('123').find((p) => p.photo_id === '1')?.deleted_at).toBeTruthy();

  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(3);

  // An empty GetUserPhotos result is not proof of deletion: a privacy change, a
  // block, or a deleted account returns the same thing. Two consecutive empty
  // reads are required before telling the subscriber the photo was removed, so
  // the first one is silent, and nothing is marked deleted in the archive.
  history = [];
  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(0);
  expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(3);
  expect(listArchivedPhotos('123').find((p) => p.photo_id === '2')?.deleted_at).toBeNull();

  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
  expect(bot.telegram.sendPhoto).toHaveBeenCalledTimes(3);

  // Once reported, it is not reported again.
  await checkSingleMonitor(row.id);
  expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);

  removeMonitor('user', '123');
  db.prepare('DELETE FROM monitor_profile_photos WHERE target_id = ?').run('123');
});
