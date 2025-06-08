import { jest } from '@jest/globals';

jest.mock('config/env-config', () => ({ BOT_ADMIN_ID: 0 }));

// Avoid importing heavy dependencies when queue-manager is loaded
jest.mock('controllers/get-stories', () => ({
  getAllStoriesFx: jest.fn(),
  getParticularStoryFx: jest.fn(),
}));
jest.mock('controllers/send-stories', () => ({ sendStoriesFx: jest.fn() }));

const sendTemporaryMessage = jest.fn();
jest.mock('../src/lib/index.ts', () => ({ sendTemporaryMessage }));

const enqueueDownloadFx: any = jest.fn();
const getQueueStatsFx: any = jest.fn();
getQueueStatsFx.mockResolvedValue({ position: 1, eta: 0 });
const wasRecentlyDownloadedFx: any = jest.fn();
const isDuplicatePendingFx: any = jest.fn();

jest.mock('db/effects', () => ({
  enqueueDownloadFx,
  getQueueStatsFx,
  wasRecentlyDownloadedFx,
  isDuplicatePendingFx,
}));

const bot = { telegram: { sendMessage: jest.fn() } } as any;
jest.mock('index', () => ({ bot }));

import { handleNewTask } from '../src/services/queue-manager';
import { UserInfo } from '../src/types';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('queue-manager duplicate handling', () => {
  test('rejects paginated request when duplicate pending', async () => {
    isDuplicatePendingFx.mockResolvedValue(true);

    const user: UserInfo = {
      chatId: '1',
      link: 'target',
      linkType: 'username',
      nextStoriesIds: [123],
      locale: 'en',
      initTime: Date.now(),
    };

    await handleNewTask(user);

    expect(isDuplicatePendingFx).toHaveBeenCalledWith({ telegram_id: '1', target_username: 'target', nextStoriesIds: [123] });
    expect(sendTemporaryMessage).toHaveBeenCalledWith(bot, '1', '⚠️ This download is already in the queue.');
    expect(enqueueDownloadFx).not.toHaveBeenCalled();
  });
});
