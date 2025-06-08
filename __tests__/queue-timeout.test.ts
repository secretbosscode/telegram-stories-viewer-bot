import { jest } from '@jest/globals';

jest.mock('config/env-config', () => ({ BOT_ADMIN_ID: 0 }));

const sendTemporaryMessage = jest.fn();
jest.mock('../src/lib/index.ts', () => ({ sendTemporaryMessage }));

const markProcessingFx = jest.fn();
const markErrorFx = jest.fn();
const markDoneFx = jest.fn();
const cleanupQueueFx = jest.fn();
const getNextQueueItemFx: any = jest.fn();

jest.mock('db/effects', () => ({
  getNextQueueItemFx,
  markProcessingFx,
  markDoneFx,
  markErrorFx,
  cleanupQueueFx,
}));

const getAllStoriesFx = jest.fn();
const getParticularStoryFx = jest.fn();
jest.mock('controllers/get-stories', () => ({
  getAllStoriesFx,
  getParticularStoryFx,
}));

const sendStoriesFx = jest.fn();
jest.mock('controllers/send-stories', () => ({ sendStoriesFx }));

const bot = { telegram: { sendMessage: jest.fn() } } as any;
jest.mock('index', () => ({ bot }));

import { processQueue, PROCESSING_TIMEOUT_MS } from '../src/services/queue-manager';

import * as queueManager from '../src/services/queue-manager';

beforeEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  (queueManager as any).PROCESSING_TIMEOUT_MS = 100;
});

afterEach(() => {
  jest.useRealTimers();
});

test('job marked error after processing timeout', async () => {
  getNextQueueItemFx.mockResolvedValueOnce({
    id: '1',
    chatId: '1',
    task: { link: 'user', linkType: 'username', locale: 'en', initTime: 0 },
  });
  getNextQueueItemFx.mockResolvedValueOnce(null);

  getAllStoriesFx.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve([]), PROCESSING_TIMEOUT_MS * 2))
  );

  processQueue();
  await new Promise((r) => setTimeout(r, PROCESSING_TIMEOUT_MS + 50));

  expect(markErrorFx).toHaveBeenCalledWith({ jobId: '1', message: 'Processing timeout' });
  expect(sendTemporaryMessage).toHaveBeenCalled();

  await new Promise((r) => setTimeout(r, PROCESSING_TIMEOUT_MS * 2));
});
