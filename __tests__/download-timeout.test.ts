import { jest } from '@jest/globals';

// Must be set before the module under test is imported.
process.env.STORY_DOWNLOAD_TIMEOUT_MS = '40';

const reconnect = jest.fn(async () => undefined);
jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn(), reconnect },
}));
jest.mock('../src/services/stealth-mode', () => ({ ensureStealthMode: jest.fn(async () => false) }));

import { Userbot } from '../src/config/userbot';
import { downloadStories } from '../src/controllers/download-stories';

test('a download that never completes fails that story instead of hanging the batch', async () => {
  const downloadMedia = jest.fn(() => new Promise<Buffer>(() => undefined)); // never settles
  (Userbot.getInstance as any).mockResolvedValue({ downloadMedia });

  const stories: any[] = [
    { id: 1, media: {}, mediaType: 'photo' },
    { id: 2, media: {}, mediaType: 'photo' },
  ];
  const started = Date.now();
  const result = await downloadStories(stories as any, 'active');
  const elapsed = Date.now() - started;

  expect(result.successCount).toBe(0);
  expect(result.failed.map((s) => s.id).sort()).toEqual([1, 2]);
  expect(stories[0].downloadError).toMatch(/timed out/);
  // Two attempts per story. The client is replaced after every stalled
  // attempt, including the final one, so a wedged sender is never handed on.
  expect(downloadMedia).toHaveBeenCalledTimes(4);
  expect(reconnect).toHaveBeenCalledTimes(4);
  // Bounded: well under a second at a 40 ms timeout, not forever.
  expect(elapsed).toBeLessThan(2000);
});

test('a download that recovers after one stall succeeds', async () => {
  reconnect.mockClear();
  let calls = 0;
  const downloadMedia = jest.fn(() => {
    calls += 1;
    return calls === 1
      ? new Promise<Buffer>(() => undefined)
      : Promise.resolve(Buffer.from('media'));
  });
  (Userbot.getInstance as any).mockResolvedValue({ downloadMedia });

  const stories: any[] = [{ id: 7, media: {}, mediaType: 'video' }];
  const result = await downloadStories(stories as any, 'active');

  expect(result.successCount).toBe(1);
  expect(stories[0].downloadStatus).toBe('success');
  expect(reconnect).toHaveBeenCalledTimes(1);
});

test('an aborted request does not start a retry after a stalled attempt', async () => {
  reconnect.mockClear();
  const downloadMedia = jest.fn(() => new Promise<Buffer>(() => undefined));
  (Userbot.getInstance as any).mockResolvedValue({ downloadMedia });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10); // aborts while the first attempt is stalled

  const stories: any[] = [{ id: 9, media: {}, mediaType: 'photo' }];
  const result = await downloadStories(stories as any, 'active', undefined, controller.signal);

  expect(result.failed.map((s) => s.id)).toEqual([9]);
  expect(stories[0].downloadError).toBe('aborted');
  expect(downloadMedia).toHaveBeenCalledTimes(1);
  // The wedged client is still replaced, but no second download is started.
  expect(reconnect).toHaveBeenCalledTimes(1);
});
