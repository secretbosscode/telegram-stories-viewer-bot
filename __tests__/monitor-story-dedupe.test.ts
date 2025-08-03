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
import { addMonitor, removeMonitor } from '../src/db';
import { checkSingleMonitor } from '../src/services/monitor-service';
import { Api } from 'telegram';
import bigInt from 'big-integer';

test('sends story again when ID reused with new date', async () => {
  const row = addMonitor('user', '123', 'tester', '999', null);

  let storyCall = 0;
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(123), accessHash: bigInt(999), username: 'tester' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      storyCall++;
      if (storyCall === 1) {
        return { stories: { stories: [{ id: 1, date: 10, expireDate: 20 }] } } as any;
      }
      return { stories: { stories: [{ id: 1, date: 30, expireDate: 40 }] } } as any;
    }
    if (query instanceof Api.photos.GetUserPhotos) {
      return { photos: [] } as any;
    }
    return {};
  });

  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const { sendActiveStories } = require('../src/controllers/send-active-stories');

  await checkSingleMonitor(row.id);
  await checkSingleMonitor(row.id);

  expect(sendActiveStories).toHaveBeenCalledTimes(2);

  removeMonitor('user', '123');
});

