import { jest } from '@jest/globals';

jest.useFakeTimers();

const mockGetNextQueueItemFx = jest.fn();
const mockMarkProcessingFx = jest.fn();
const mockMarkDoneFx = jest.fn();
const mockMarkErrorFx = jest.fn();
const mockCleanupQueueFx = jest.fn();

jest.mock('../src/db/effects', () => ({
  enqueueDownloadFx: jest.fn(),
  getNextQueueItemFx: mockGetNextQueueItemFx,
  markProcessingFx: mockMarkProcessingFx,
  markDoneFx: mockMarkDoneFx,
  markErrorFx: mockMarkErrorFx,
  cleanupQueueFx: mockCleanupQueueFx,
  wasRecentlyDownloadedFx: jest.fn(),
  isDuplicatePendingFx: jest.fn(),
  getQueueStatsFx: jest.fn(),
  findPendingJobFx: jest.fn(),
}));

const mockGetAllStoriesFx = jest.fn();

jest.mock('../src/controllers/get-stories', () => ({
  getAllStoriesFx: mockGetAllStoriesFx,
  getParticularStoryFx: jest.fn(),
}));

jest.mock('../src/controllers/send-stories', () => ({
  sendStoriesFx: jest.fn(),
}));

jest.mock('lib', () => ({
  sendTemporaryMessage: jest.fn(() => Promise.resolve()),
}), { virtual: true });

jest.mock('../src/index', () => ({
  bot: { telegram: { sendMessage: jest.fn(), deleteMessage: jest.fn() } },
}));

jest.mock('../src/config/env-config', () => ({ BOT_ADMIN_ID: 1 }));

import { processQueue, PROCESSING_TIMEOUT_MS } from '../src/services/queue-manager';

describe('queue manager timeout', () => {
  test('marks job as error when processing takes too long', async () => {
    const job = {
      id: '1',
      chatId: '123',
      task: { link: 'user', linkType: 'username', chatId: '123' },
      status: 'pending',
      enqueued_ts: 0,
    } as any;

    (mockGetNextQueueItemFx as any).mockResolvedValueOnce(job).mockResolvedValueOnce(null);

    mockGetAllStoriesFx.mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve([]), PROCESSING_TIMEOUT_MS * 2)),
    );

    const promise = processQueue();

    jest.advanceTimersByTime(PROCESSING_TIMEOUT_MS + 1000);
    await jest.runOnlyPendingTimersAsync();

    expect(mockMarkProcessingFx).toHaveBeenCalledWith(job.id);
    expect(mockMarkErrorFx).toHaveBeenCalledWith({ jobId: job.id, message: 'Processing timeout' });

    jest.runOnlyPendingTimers();
    await promise;
  });
});
