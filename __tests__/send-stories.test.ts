import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  BOT_TOKEN: 'token',
  LOG_FILE: '/tmp/test.log',
}));

const sendParticularStory: any = jest.fn(async () => [1]);
jest.mock('../src/controllers/send-particular-story', () => ({ sendParticularStory }));

class PartialStoryDeliveryError extends Error {
  deliveredStoryIds: number[];
  constructor(deliveredStoryIds: number[]) {
    super('partial batch failure');
    this.deliveredStoryIds = deliveredStoryIds;
  }
}
const sendPaginatedStories: any = jest.fn(async () => [1]);
jest.mock('../src/controllers/send-paginated-stories', () => ({
  sendPaginatedStories,
  PartialStoryDeliveryError,
}));

const sendActiveStories: any = jest.fn(async () => []);
jest.mock('../src/controllers/send-active-stories', () => ({ sendActiveStories }));
const sendPinnedStories: any = jest.fn(async () => []);
jest.mock('../src/controllers/send-pinned-stories', () => ({ sendPinnedStories }));
const sendGlobalStories = jest.fn();
jest.mock('../src/controllers/send-global-stories', () => ({ sendGlobalStories }));
jest.mock('../src/controllers/download-stories', () => ({ mapStories: jest.fn((stories: any) => stories) }));

const maybeOfferStoryUnlock = jest.fn(async () => false);
const markStarsBundleDelivered = jest.fn();
const recordStarsDeliveryFailure = jest.fn();
const refundUndeliverableStarsBundle = jest.fn(async () => true);
const isStarsMode = jest.fn(() => false);
const areStarsEnabled = jest.fn(() => true);
const isStarsBundleDeliverable = jest.fn(() => true);
jest.mock('../src/services/stars-payment', () => ({
  maybeOfferStoryUnlock,
  markStarsBundleDelivered,
  recordStarsDeliveryFailure,
  refundUndeliverableStarsBundle,
  isStarsMode,
  areStarsEnabled,
  isStarsBundleDeliverable,
}));

const sendTemporaryMessage = jest.fn();
jest.mock('../src/lib/helpers.ts', () => ({
  ...(jest.requireActual('../src/lib/helpers.ts') as any),
  sendTemporaryMessage,
}));

const bot = { telegram: { sendMessage: jest.fn(async () => undefined) } } as any;
jest.mock('../src/index.ts', () => ({ bot }));

import { sendStoriesFx } from '../src/controllers/send-stories';
import { SendStoriesFxParams } from '../src/types';

describe('sendStoriesFx', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    maybeOfferStoryUnlock.mockResolvedValue(false);
    isStarsMode.mockReturnValue(false);
    areStarsEnabled.mockReturnValue(true);
    isStarsBundleDeliverable.mockReturnValue(true);
    sendParticularStory.mockResolvedValue([1]);
    sendPaginatedStories.mockResolvedValue([1]);
    sendActiveStories.mockResolvedValue([]);
    sendPinnedStories.mockResolvedValue([]);
  });

  test('sends persistent completion message', async () => {
    const params: SendStoriesFxParams = {
      particularStory: { id: 1 } as any,
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
      { link_preview_options: { is_disabled: true } },
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

    expect(sendTemporaryMessage).toHaveBeenCalledWith(
      bot,
      '1',
      '🤷 No public stories found for user.',
      { link_preview_options: { is_disabled: true } },
    );
  });

  test('paused Stars mode never falls through to free media delivery', async () => {
    isStarsMode.mockReturnValue(true);
    areStarsEnabled.mockReturnValue(false);

    await sendStoriesFx({
      particularStory: { id: 55 } as any,
      task: {
        chatId: '55',
        link: '@target',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
        user: { id: 55, is_bot: false, first_name: 'User' },
      },
    } as any);

    expect(sendParticularStory).not.toHaveBeenCalled();
    expect(maybeOfferStoryUnlock).not.toHaveBeenCalled();
    expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
      '55',
      expect.stringContaining('paused'),
    );
  });



  test('does not send paid media after refund fencing begins', async () => {
    isStarsBundleDeliverable.mockReturnValue(false);

    await sendStoriesFx({
      particularStory: { id: 88 } as any,
      task: {
        chatId: '88',
        link: '@target',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
        starsUnlocked: true,
        starsBundleId: 'bundle-refunding',
        starsExpectedStoryIds: [88],
      },
    } as any);

    expect(sendParticularStory).not.toHaveBeenCalled();
    expect(markStarsBundleDelivered).not.toHaveBeenCalled();
    expect(refundUndeliverableStarsBundle).not.toHaveBeenCalled();
  });

  test('refunds a paid particular story when Telegram received no media', async () => {
    sendParticularStory.mockResolvedValue([]);

    await sendStoriesFx({
      particularStory: { id: 66 } as any,
      task: {
        chatId: '66',
        link: '@target',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
        starsUnlocked: true,
        starsBundleId: 'bundle-particular',
        starsExpectedStoryIds: [66],
      },
    } as any);

    expect(markStarsBundleDelivered).not.toHaveBeenCalled();
    expect(refundUndeliverableStarsBundle).toHaveBeenCalledWith('bundle-particular');
  });

  test('refunds a paid bundle when no media or fallback was sent', async () => {
    sendPaginatedStories.mockResolvedValue([]);

    await sendStoriesFx({
      paginatedStories: [{ id: 77 }] as any,
      task: {
        chatId: '77',
        link: '@target',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
        starsUnlocked: true,
        starsBundleId: 'bundle-77',
        starsExpectedStoryIds: [77],
      },
    } as any);

    expect(markStarsBundleDelivered).not.toHaveBeenCalled();
    expect(recordStarsDeliveryFailure).toHaveBeenCalled();
    expect(refundUndeliverableStarsBundle).toHaveBeenCalledWith('bundle-77');
  });

  test('refunds a partially delivered paid bundle instead of finalizing it', async () => {
    sendPaginatedStories.mockResolvedValue([88]);

    await sendStoriesFx({
      paginatedStories: [{ id: 88 }, { id: 89 }] as any,
      task: {
        chatId: '88',
        link: '@target',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
        starsUnlocked: true,
        starsBundleId: 'bundle-partial',
        starsExpectedStoryIds: [88, 89],
      },
    } as any);

    expect(markStarsBundleDelivered).not.toHaveBeenCalled();
    expect(recordStarsDeliveryFailure).toHaveBeenCalledWith(
      'bundle-partial',
      expect.objectContaining({ message: expect.stringContaining('1/2') }),
    );
    expect(refundUndeliverableStarsBundle).toHaveBeenCalledWith('bundle-partial');
  });

  test('refunds instead of retrying when a later media batch throws', async () => {
    sendPaginatedStories.mockRejectedValue(new PartialStoryDeliveryError([88]));

    await sendStoriesFx({
      paginatedStories: [{ id: 88 }, { id: 89 }] as any,
      task: {
        chatId: '88',
        link: '@target',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
        starsUnlocked: true,
        starsBundleId: 'bundle-batch-error',
        starsExpectedStoryIds: [88, 89],
      },
    } as any);

    expect(recordStarsDeliveryFailure).toHaveBeenCalledWith(
      'bundle-batch-error',
      expect.any(PartialStoryDeliveryError),
    );
    expect(refundUndeliverableStarsBundle).toHaveBeenCalledWith('bundle-batch-error');
    expect(markStarsBundleDelivered).not.toHaveBeenCalled();
  });


  test('does not deliver a story twice when Telegram returns it as active and pinned', async () => {
    sendActiveStories.mockResolvedValue([7]);
    sendPinnedStories.mockResolvedValue([8]);

    await sendStoriesFx({
      activeStories: [{ id: 7 }] as any,
      pinnedStories: [{ id: 7 }, { id: 8 }] as any,
      task: {
        chatId: '7',
        link: '@target',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
      },
    } as any);

    expect(sendActiveStories).toHaveBeenCalledWith(
      expect.objectContaining({ stories: [{ id: 7 }] }),
    );
    expect(sendPinnedStories).toHaveBeenCalledWith(
      expect.objectContaining({ stories: [{ id: 8 }] }),
    );
  });

  test('marks a paid bundle delivered only when every purchased ID was delivered', async () => {
    sendPaginatedStories.mockResolvedValue([88, 89]);

    await sendStoriesFx({
      paginatedStories: [{ id: 88 }, { id: 89 }] as any,
      task: {
        chatId: '88',
        link: '@target',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
        starsUnlocked: true,
        starsBundleId: 'bundle-88',
        starsExpectedStoryIds: [88, 89],
      },
    } as any);

    expect(markStarsBundleDelivered).toHaveBeenCalledWith('bundle-88');
    expect(refundUndeliverableStarsBundle).not.toHaveBeenCalled();
  });
});
