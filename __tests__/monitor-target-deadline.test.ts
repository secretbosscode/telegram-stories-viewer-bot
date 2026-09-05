import { jest } from '@jest/globals';

// Must be set before the module under test is imported.
process.env.MONITOR_TARGET_DEADLINE_MS = '60';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));
jest.mock('../src/index', () => ({
  bot: { telegram: { sendMessage: jest.fn(), sendPhoto: jest.fn(), sendVideo: jest.fn() } },
}));
jest.mock('controllers/send-active-stories', () => ({ sendActiveStories: jest.fn(async () => []) }));
jest.mock('controllers/download-stories', () => ({ mapStories: jest.fn((s: any) => s) }));
jest.mock('../src/config/env-config', () => ({ BOT_ADMIN_ID: 0, LOG_FILE: '/tmp/test.log' }));
jest.mock('lib/i18n', () => ({ t: () => '' }));
jest.mock('../src/services/premium-service', () => ({ isUserPremium: jest.fn(() => true) }));

import { Userbot } from '../src/config/userbot';
import { addMonitor, removeMonitor, getMonitor } from '../src/db';
import { forceCheckMonitors, stopMonitorLoop } from '../src/services/monitor-service';
import { Api } from 'telegram';
import bigInt from 'big-integer';

afterEach(() => stopMonitorLoop());

test('a target whose story fetch never returns is abandoned and the cycle continues', async () => {
  const stuck = addMonitor('deadline-user', '111001', 'stuck', '999', null);
  const healthy = addMonitor('deadline-user', '111002', 'healthy', '999', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      const id = (query as any).id?.[0]?.userId?.toString?.() ?? '';
      return [{ id: bigInt(Number(id) || 0), accessHash: bigInt(999), username: id === '111001' ? 'stuck' : 'healthy' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      const id = (query as any).peer?.userId?.toString?.();
      if (id === '111001') return new Promise(() => undefined); // hangs forever
      return { stories: { stories: [] } } as any;
    }
    if (query instanceof Api.stories.GetPinnedStories) {
      const id = (query as any).peer?.userId?.toString?.();
      if (id === '111001') return new Promise(() => undefined);
      return { stories: [] } as any;
    }
    if (query instanceof Api.photos.GetUserPhotos) return { photos: [] } as any;
    return {};
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  try {
    const started = Date.now();
    await forceCheckMonitors();
    expect(Date.now() - started).toBeLessThan(5000);
    // Both targets were attempted; the healthy one completed its story fetch.
    const mine = new Set(['111001', '111002']);
    const fetched = invoke.mock.calls
      .filter((c) => c[0] instanceof Api.stories.GetPeerStories)
      .map((c) => (c[0] as any).peer?.userId?.toString?.())
      .filter((id) => mine.has(id))
      .sort();
    expect(fetched).toEqual(['111001', '111002']);
    // Both rows were stamped as checked, so the loop does not treat the
    // stuck one as never having run.
    expect(getMonitor(stuck.id)?.last_checked).toBeTruthy();
    expect(getMonitor(healthy.id)?.last_checked).toBeTruthy();
  } finally {
    removeMonitor('deadline-user', '111001');
    removeMonitor('deadline-user', '111002');
  }
});

test('a hang during the username refresh is bounded too', async () => {
  const stuck = addMonitor('deadline-user', '111003', 'refreshstuck', '999', null);
  const healthy = addMonitor('deadline-user', '111004', 'refreshok', '999', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      const id = (query as any).id?.[0]?.userId?.toString?.() ?? '';
      if (id === '111003') return new Promise(() => undefined); // refresh hangs
      return [{ id: bigInt(Number(id) || 0), accessHash: bigInt(999), username: 'refreshok' }];
    }
    if (query instanceof Api.stories.GetPeerStories) return { stories: { stories: [] } } as any;
    if (query instanceof Api.stories.GetPinnedStories) return { stories: [] } as any;
    if (query instanceof Api.photos.GetUserPhotos) return { photos: [] } as any;
    return {};
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  try {
    const started = Date.now();
    await forceCheckMonitors();
    expect(Date.now() - started).toBeLessThan(5000);
    const mine = new Set(['111003', '111004']);
    const fetched = invoke.mock.calls
      .filter((c) => c[0] instanceof Api.stories.GetPeerStories)
      .map((c) => (c[0] as any).peer?.userId?.toString?.())
      .filter((id) => mine.has(id));
    expect(fetched).toEqual(['111004']);
    expect(getMonitor(stuck.id)?.last_checked).toBeTruthy();
    expect(getMonitor(healthy.id)?.last_checked).toBeTruthy();
  } finally {
    removeMonitor('deadline-user', '111003');
    removeMonitor('deadline-user', '111004');
  }
});

test('an abandoned delivery is not started again while it is still in flight', async () => {
  const row = addMonitor('deadline-user', '111005', 'slowsend', '999', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(111005), accessHash: bigInt(999), username: 'slowsend' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      // Only this test's target has a story; neighbours from other suites
      // sharing the database must not trigger sends here.
      const id = (query as any).peer?.userId?.toString?.();
      if (id !== '111005') return { stories: { stories: [] } } as any;
      return { stories: { stories: [{ id: 3, date: 30, expireDate: 2000000000 }] } } as any;
    }
    if (query instanceof Api.stories.GetPinnedStories) return { stories: [] } as any;
    if (query instanceof Api.photos.GetUserPhotos) return { photos: [] } as any;
    return {};
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const { sendActiveStories } = require('../src/controllers/send-active-stories');
  (sendActiveStories as jest.Mock).mockReset();
  (sendActiveStories as jest.Mock).mockImplementation(() => new Promise(() => undefined)); // never settles

  try {
    await forceCheckMonitors(); // abandoned at the deadline
    await forceCheckMonitors(); // must not start a second send for the same monitor
    const sendsToMe = (sendActiveStories as jest.Mock).mock.calls
      .filter((c: any[]) => c[0]?.task?.chatId === 'deadline-user');
    expect(sendsToMe).toHaveLength(1);
    expect(row.id).toBeGreaterThan(0);
  } finally {
    (sendActiveStories as jest.Mock).mockReset();
    (sendActiveStories as jest.Mock<any>).mockResolvedValue([]);
    removeMonitor('deadline-user', '111005');
  }
});
