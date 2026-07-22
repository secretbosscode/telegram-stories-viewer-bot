import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  BOT_TOKEN: 'token',
  LOG_FILE: '/tmp/test.log',
}));

const sendParticularStory = jest.fn();
jest.mock('../src/controllers/send-particular-story', () => ({ sendParticularStory }));
const sendPaginatedStories = jest.fn(async () => 1);
jest.mock('../src/controllers/send-paginated-stories', () => ({ sendPaginatedStories }));
const sendActiveStories = jest.fn();
jest.mock('../src/controllers/send-active-stories', () => ({ sendActiveStories }));
const sendPinnedStories = jest.fn();
jest.mock('../src/controllers/send-pinned-stories', () => ({ sendPinnedStories }));
const sendGlobalStories = jest.fn();
jest.mock('../src/controllers/send-global-stories', () => ({ sendGlobalStories }));
jest.mock('../src/controllers/download-stories', () => ({ mapStories: jest.fn((s: any) => s) }));

const maybeOfferStoryUnlock = jest.fn(async () => false);
const markStarsBundleDelivered = jest.fn();
const recordStarsDeliveryFailure = jest.fn();
const refundUndeliverableStarsBundle = jest.fn(async () => true);
const isStarsMode = jest.fn(() => false);
const areStarsEnabled = jest.fn(() => true);
jest.mock('../src/services/stars-payment', () => ({
  maybeOfferStoryUnlock,
  markStarsBundleDelivered,
  recordStarsDeliveryFailure,
  refundUndeliverableStarsBundle,
  isStarsMode,
  areStarsEnabled,
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
    sendPaginatedStories.mockResolvedValue(1);
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
      particularStory: {} as any,
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

  test('does not mark a paid bundle delivered when no media or fallback was sent', async () => {
    sendPaginatedStories.mockResolvedValue(0);

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
      },
    } as any);

    expect(markStarsBundleDelivered).not.toHaveBeenCalled();
    expect(refundUndeliverableStarsBundle).toHaveBeenCalledWith('bundle-77');
  });

  test('marks a paid bundle delivered only after at least one result was sent', async () => {
    sendPaginatedStories.mockResolvedValue(1);

    await sendStoriesFx({
      paginatedStories: [{ id: 88 }] as any,
      task: {
        chatId: '88',
        link: '@target',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
        starsUnlocked: true,
        starsBundleId: 'bundle-88',
      },
    } as any);

    expect(markStarsBundleDelivered).toHaveBeenCalledWith('bundle-88');
    expect(refundUndeliverableStarsBundle).not.toHaveBeenCalled();
  });
});
