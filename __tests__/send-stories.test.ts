import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  BOT_TOKEN: 'token',
  LOG_FILE: '/tmp/test.log',
}));

const sendParticularStory = jest.fn();
jest.mock('../src/controllers/send-particular-story', () => ({ sendParticularStory }));
const sendPaginatedStories = jest.fn();
jest.mock('../src/controllers/send-paginated-stories', () => ({ sendPaginatedStories }));
const sendActiveStories = jest.fn();
jest.mock('../src/controllers/send-active-stories', () => ({ sendActiveStories }));
const sendPinnedStories = jest.fn();
jest.mock('../src/controllers/send-pinned-stories', () => ({ sendPinnedStories }));
const sendGlobalStories = jest.fn();
jest.mock('../src/controllers/send-global-stories', () => ({ sendGlobalStories }));
jest.mock('../src/controllers/download-stories', () => ({ mapStories: jest.fn((s: any) => s) }));

// This suite covers the existing delivery orchestrator. Stars offer creation
// has its own dedicated tests and is kept out of these assertions.
const maybeOfferStoryUnlock = jest.fn(async () => false);
const markStarsBundleDelivered = jest.fn();
const recordStarsDeliveryFailure = jest.fn();
const refundUndeliverableStarsBundle = jest.fn(async () => true);
jest.mock('../src/services/stars-payment', () => ({
  maybeOfferStoryUnlock,
  markStarsBundleDelivered,
  recordStarsDeliveryFailure,
  refundUndeliverableStarsBundle,
}));

const sendTemporaryMessage = jest.fn();
jest.mock('../src/lib/helpers.ts', () => ({
  ...(jest.requireActual('../src/lib/helpers.ts') as any),
  sendTemporaryMessage,
}));

const bot = { telegram: { sendMessage: jest.fn() } } as any;
jest.mock('../src/index.ts', () => ({ bot }));

import { sendStoriesFx } from '../src/controllers/send-stories';
import { SendStoriesFxParams } from '../src/types';

describe('sendStoriesFx', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    maybeOfferStoryUnlock.mockResolvedValue(false);
  });

  test('sends persistent completion message', async () => {
    const params: SendStoriesFxParams = {
      particularStory: {} as any,
      task: {
        chatId: '1',
        link: 'user',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
      },
    } as any;

    await sendStoriesFx(params);

    expect(sendParticularStory).toHaveBeenCalled();
    expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
      '1',
      '🎉 Download for user completed!',
      { link_preview_options: { is_disabled: true } }
    );
    expect(sendTemporaryMessage).not.toHaveBeenCalledWith(
      bot,
      '1',
      expect.any(String),
      expect.anything()
    );
  });

  test('uses temporary message when no stories found', async () => {
    const params: SendStoriesFxParams = {
      task: {
        chatId: '1',
        link: 'user',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
      },
    } as any;

    await sendStoriesFx(params);

    expect(bot.telegram.sendMessage).not.toHaveBeenCalledWith(
      '1',
      expect.any(String)
    );
    expect(sendTemporaryMessage).toHaveBeenCalledWith(
      bot,
      '1',
      '🤷 No public stories found for user.',
      { link_preview_options: { is_disabled: true } }
    );
  });
});
