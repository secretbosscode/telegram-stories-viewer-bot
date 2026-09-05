import { jest } from '@jest/globals';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));
jest.mock('../src/index', () => ({
  bot: { telegram: { sendPhoto: jest.fn(), sendVideo: jest.fn(), sendMessage: jest.fn() } },
}));
jest.mock('controllers/send-active-stories', () => ({ sendActiveStories: jest.fn() }));
jest.mock('controllers/download-stories', () => ({ mapStories: jest.fn((s: any) => s) }));
jest.mock('../src/config/env-config', () => ({ BOT_ADMIN_ID: 0, LOG_FILE: '/tmp/test.log' }));
jest.mock('lib/i18n', () => ({ t: (_l: string, key: string) => key }));

import { Userbot } from '../src/config/userbot';
import { addMonitor, removeMonitor, db } from '../src/db';
import { checkSingleMonitor } from '../src/services/monitor-service';
import { Api } from 'telegram';
import bigInt from 'big-integer';

const TARGET = '555001';

afterAll(() => {
  db.prepare('DELETE FROM monitor_profile_photos WHERE target_id = ?').run(TARGET);
  db.prepare('DELETE FROM monitor_photo_deletion_acks WHERE target_id = ?').run(TARGET);
});

test('a deletion notice is retried per subscriber until Telegram accepts it', async () => {
  db.prepare('DELETE FROM monitor_profile_photos WHERE target_id = ?').run(TARGET);
  const a = addMonitor('ack-a', TARGET, 'acked', '999', null);
  const b = addMonitor('ack-b', TARGET, 'acked', '999', null);
  let history: number[] = [1];
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(Number(TARGET)), accessHash: bigInt(999), username: 'acked' }];
    }
    if (query instanceof Api.stories.GetPeerStories) return { stories: { stories: [] } } as any;
    if (query instanceof Api.stories.GetPinnedStories) return { stories: [] } as any;
    if (query instanceof Api.photos.GetUserPhotos) {
      return { photos: history.map((id) => ({ id, videoSizes: [] })) } as any;
    }
    return null;
  });
  const downloadMedia = jest.fn<(...args: any[]) => Promise<Buffer>>().mockResolvedValue(Buffer.from('img'));
  (Userbot.getInstance as any).mockResolvedValue({ invoke, downloadMedia } as any);
  const { bot } = require('../src/index');
  const deletionSends = () =>
    (bot.telegram.sendPhoto as jest.Mock).mock.calls
      .filter((c: any[]) => c[2]?.caption === 'monitor.photoDeleted')
      .map((c: any[]) => c[0]);

  try {
    // Baseline check for both, then a new avatar, then the old one is deleted.
    await checkSingleMonitor(a.id);
    await checkSingleMonitor(b.id);
    history = [2, 1];
    await checkSingleMonitor(a.id);
    await checkSingleMonitor(b.id);
    history = [2];

    const acked = (monitorId: number) =>
      (db.prepare('SELECT COUNT(*) AS c FROM monitor_photo_deletion_acks WHERE monitor_id = ?').get(monitorId) as any).c;

    // Subscriber a receives the deletion; subscriber b's send is attempted but
    // rejected by Telegram, so it must not be acknowledged.
    await checkSingleMonitor(a.id);
    expect(deletionSends()).toEqual(['ack-a']);
    expect(acked(a.id)).toBe(1);
    (bot.telegram.sendPhoto as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('403: bot was blocked by the user');
    });
    await checkSingleMonitor(b.id);
    expect(deletionSends()).toEqual(['ack-a', 'ack-b']);
    expect(acked(b.id)).toBe(0);

    // Next cycle: a is not told again, b is retried and now acknowledged.
    await checkSingleMonitor(a.id);
    await checkSingleMonitor(b.id);
    expect(deletionSends()).toEqual(['ack-a', 'ack-b', 'ack-b']);
    expect(acked(a.id)).toBe(1);
    expect(acked(b.id)).toBe(1);

    // And nobody is told again afterwards.
    await checkSingleMonitor(a.id);
    await checkSingleMonitor(b.id);
    expect(deletionSends()).toEqual(['ack-a', 'ack-b', 'ack-b']);
  } finally {
    removeMonitor('ack-a', TARGET);
    removeMonitor('ack-b', TARGET);
  }
});
