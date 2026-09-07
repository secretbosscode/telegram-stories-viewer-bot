import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  BOT_TOKEN: 'token',
  LOG_FILE: '/tmp/test.log',
}));

const sendTemporaryMessage = jest.fn(async () => {});
jest.mock('lib', () => ({
  ...(jest.requireActual('../src/lib/index.ts') as any),
  sendTemporaryMessage,
}));

const notifyAdmin = jest.fn();
jest.mock('controllers/send-message', () => ({ notifyAdmin }));

const downloadStories: any = jest.fn();
jest.mock('controllers/download-stories', () => ({
  downloadStories,
  mapStories: jest.fn((stories: any) => stories),
}));

const sendStoryFallbacks: any = jest.fn();
jest.mock('controllers/story-fallback', () => ({ sendStoryFallbacks }));

jest.mock('config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));

const bot = {
  telegram: {
    sendMediaGroup: jest.fn(async () => []),
    sendMessage: jest.fn(async () => ({ message_id: 1 })),
    sendPhoto: jest.fn(async () => ({ message_id: 1 })),
    sendVideo: jest.fn(async () => ({ message_id: 1 })),
  },
} as any;
jest.mock('index', () => ({ bot }));

jest.mock('lib/i18n', () => ({ t: (_locale: string, key: string) => key }));

import { sendActiveStories } from '../src/controllers/send-active-stories';
import { MappedStoryItem, SendStoriesArgs } from '../src/types';

function makeStory(overrides: Partial<MappedStoryItem> = {}): MappedStoryItem {
  return {
    id: 1,
    media: {} as any,
    mediaType: 'photo',
    date: new Date(),
    buffer: Buffer.from('x'),
    bufferSize: 1,
    caption: 'Original',
    ...overrides,
  };
}

function makeArgs(stories: MappedStoryItem[]): SendStoriesArgs {
  return {
    stories,
    task: {
      chatId: '1',
      link: 'user',
      linkType: 'username',
      locale: 'en',
      initTime: 0,
    } as any,
  };
}

describe('sendActiveStories delivery accounting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    downloadStories.mockResolvedValue({ successCount: 1, failed: [], skipped: [] });
    sendStoryFallbacks.mockResolvedValue([]);
  });

  test('sends one photo directly and returns its delivered ID', async () => {
    const story = makeStory();

    const deliveredIds = await sendActiveStories(makeArgs([story]));

    expect(bot.telegram.sendMediaGroup).not.toHaveBeenCalled();
    expect(bot.telegram.sendPhoto).toHaveBeenCalledWith(
      '1',
      { source: story.buffer },
      { caption: 'Original\n\nActive story from user' },
    );
    expect(deliveredIds).toEqual([1]);
    expect(sendTemporaryMessage).toHaveBeenCalledTimes(2);
  });

  test('returns only IDs whose exported fallback links were sent', async () => {
    const failedStory = makeStory({ id: 2, buffer: undefined, bufferSize: undefined });
    downloadStories.mockResolvedValue({
      successCount: 0,
      failed: [failedStory],
      skipped: [],
    });
    sendStoryFallbacks.mockResolvedValue([2]);

    const deliveredIds = await sendActiveStories(makeArgs([failedStory]));

    expect(sendStoryFallbacks).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '1' }),
      expect.arrayContaining([expect.objectContaining({ id: 2 })]),
    );
    expect(deliveredIds).toEqual([2]);
    expect(bot.telegram.sendMessage).not.toHaveBeenCalledWith('1', 'active.none');
  });

  test.each([
    ['regular', '1', {}],
    ['admin', '0', {}],
    ['paid', '2', { starsBundleId: 1 }],
  ])('keeps delivered media forwardable for %s users', async (_role, chatId, entitlement) => {
    const photo = makeStory({ noforwards: true });
    const video = makeStory({ id: 2, mediaType: 'video', noforwards: true });
    const args = makeArgs([photo]);
    Object.assign(args.task, { chatId, user: { id: Number(chatId) }, ...entitlement });

    expect(await sendActiveStories(args)).toEqual([1]);
    expect(bot.telegram.sendPhoto.mock.calls[0][2].protect_content).not.toBe(true);

    expect(await sendActiveStories({ ...args, stories: [video] })).toEqual([2]);
    expect(bot.telegram.sendVideo.mock.calls[0][2].protect_content).not.toBe(true);

    // One restricted source must not lock every item in a mixed album.
    const unrestricted = makeStory({ id: 3, noforwards: false });
    expect(await sendActiveStories({ ...args, stories: [photo, unrestricted] })).toEqual([1, 3]);
    expect(bot.telegram.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(bot.telegram.sendMediaGroup.mock.calls[0][2]?.protect_content).not.toBe(true);
  });

  test('returns no IDs when media and fallback delivery both fail', async () => {
    const failedStory = makeStory({ id: 3, buffer: undefined, bufferSize: undefined });
    downloadStories.mockResolvedValue({
      successCount: 0,
      failed: [failedStory],
      skipped: [],
    });
    sendStoryFallbacks.mockResolvedValue([]);

    const deliveredIds = await sendActiveStories(makeArgs([failedStory]));

    expect(deliveredIds).toEqual([]);
    expect(bot.telegram.sendMessage).toHaveBeenCalledWith('1', 'active.none');
  });

  test('returns the exact successful subset from mixed media and fallback delivery', async () => {
    const uploaded = makeStory({ id: 4 });
    const failed = makeStory({ id: 5, buffer: undefined, bufferSize: undefined });
    downloadStories.mockResolvedValue({
      successCount: 1,
      failed: [failed],
      skipped: [],
    });
    sendStoryFallbacks.mockResolvedValue([]);

    const deliveredIds = await sendActiveStories(makeArgs([uploaded, failed]));

    expect(deliveredIds).toEqual([4]);
  });
});
