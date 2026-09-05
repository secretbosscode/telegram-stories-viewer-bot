import { jest } from '@jest/globals';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));
jest.mock('../src/index', () => ({
  bot: { telegram: { sendMessage: jest.fn(), sendPhoto: jest.fn(), sendVideo: jest.fn() } },
}));
jest.mock('controllers/send-active-stories', () => ({
  sendActiveStories: jest.fn(),
}));
jest.mock('controllers/download-stories', () => ({
  mapStories: jest.fn((stories: any) => stories),
}));
jest.mock('../src/config/env-config', () => ({ BOT_ADMIN_ID: 0, LOG_FILE: '/tmp/test.log' }));
jest.mock('lib/i18n', () => ({ t: () => '' }));
jest.mock('../src/services/premium-service', () => ({
  isUserPremium: jest.fn(() => true),
}));

import { Userbot } from '../src/config/userbot';
import { addMonitor, removeMonitor, listSentStoryKeys, setBotBlocked } from '../src/db';
import { forceCheckMonitors, stopMonitorLoop } from '../src/services/monitor-service';
import { Api } from 'telegram';
import bigInt from 'big-integer';

afterEach(() => {
  stopMonitorLoop();
});

test('a target watched by several subscribers is fetched once and delivered to each', async () => {
  const a = addMonitor('shared-a', '321', 'shared', '999', null);
  const b = addMonitor('shared-b', '321', 'shared', '999', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(321), accessHash: bigInt(999), username: 'shared' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      return { stories: { stories: [{ id: 5, date: 50, expireDate: 2000000000 }] } } as any;
    }
    if (query instanceof Api.stories.GetPinnedStories) {
      return { stories: [] } as any;
    }
    if (query instanceof Api.photos.GetUserPhotos) {
      return { photos: [] } as any;
    }
    return {};
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const { sendActiveStories } = require('../src/controllers/send-active-stories');
  (sendActiveStories as jest.Mock).mockReset();
  (sendActiveStories as any).mockResolvedValue([5]);

  try {
    await forceCheckMonitors();

    const storyFetches = invoke.mock.calls.filter(
      (call) => call[0] instanceof Api.stories.GetPeerStories,
    );
    expect(storyFetches).toHaveLength(1);

    const deliveredTo = (sendActiveStories as jest.Mock).mock.calls
      .map((call: any[]) => call[0].task.chatId)
      .sort();
    expect(deliveredTo).toEqual(['shared-a', 'shared-b']);
    expect(listSentStoryKeys(a.id, 'active')).toContain('5:50');
    expect(listSentStoryKeys(b.id, 'active')).toContain('5:50');
  } finally {
    removeMonitor('shared-a', '321');
    removeMonitor('shared-b', '321');
  }
});

test('subscribers who blocked the bot are skipped without losing their monitor', async () => {
  const blocked = addMonitor('blocked-user', '654', 'quiet', '999', null);
  setBotBlocked('blocked-user', true);
  const invoke = jest.fn(async () => ({ stories: { stories: [] } }));
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  try {
    await forceCheckMonitors();
    expect(invoke).not.toHaveBeenCalled();
    expect(blocked.id).toBeGreaterThan(0);
  } finally {
    setBotBlocked('blocked-user', false);
    removeMonitor('blocked-user', '654');
  }
});

test('a forced check still runs after /stopmonitor and does not restart the scheduler', async () => {
  const row = addMonitor('force-user', '987', 'forced', '999', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(987), accessHash: bigInt(999), username: 'forced' }];
    }
    if (query instanceof Api.stories.GetPeerStories) return { stories: { stories: [] } } as any;
    if (query instanceof Api.stories.GetPinnedStories) return { stories: [] } as any;
    if (query instanceof Api.photos.GetUserPhotos) return { photos: [] } as any;
    return {};
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const { getNextMonitorCheck } = require('../src/services/monitor-service');

  try {
    stopMonitorLoop();
    await forceCheckMonitors();
    expect(invoke.mock.calls.some((c) => c[0] instanceof Api.stories.GetPeerStories)).toBe(true);
    expect(getNextMonitorCheck()).toBeNull();
    expect(row.id).toBeGreaterThan(0);
  } finally {
    removeMonitor('force-user', '987');
  }
});
