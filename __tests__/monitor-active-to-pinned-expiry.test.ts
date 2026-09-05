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
jest.mock('lib/i18n', () => ({ t: () => '' }));

import { Userbot } from '../src/config/userbot';
import { addMonitor, removeMonitor, pruneOrphanedSentStories } from '../src/db';
import { checkSingleMonitor } from '../src/services/monitor-service';
import { Api } from 'telegram';
import bigInt from 'big-integer';

test('a story delivered while active is not re-sent when it reappears pinned after expiry', async () => {
  const row = addMonitor('expiry-user', '4242', 'expiry', '999', null);
  const now = Math.floor(Date.now() / 1000);
  // The story's active window has already closed by the time it is seen, which
  // is what a real cycle looks like just after the 24-hour mark.
  const story = { id: 7, date: now - 90_000, expireDate: now - 3_600 };
  let cycle = 0;
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(4242), accessHash: bigInt(999), username: 'expiry' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      return { stories: { stories: cycle === 0 ? [story] : [] } } as any;
    }
    if (query instanceof Api.stories.GetPinnedStories) {
      return { stories: cycle === 0 ? [] : [story] } as any;
    }
    if (query instanceof Api.photos.GetUserPhotos) return { photos: [] } as any;
    return {};
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const { sendActiveStories } = require('../src/controllers/send-active-stories');
  (sendActiveStories as jest.Mock).mockReset();
  (sendActiveStories as any).mockResolvedValue([7]);

  try {
    await checkSingleMonitor(row.id);
    expect(sendActiveStories).toHaveBeenCalledTimes(1);

    // Maintenance runs between cycles; it must not erase the evidence.
    pruneOrphanedSentStories();

    cycle = 1;
    await checkSingleMonitor(row.id);
    await checkSingleMonitor(row.id);
    expect(sendActiveStories).toHaveBeenCalledTimes(1);
  } finally {
    removeMonitor('expiry-user', '4242');
  }
});
