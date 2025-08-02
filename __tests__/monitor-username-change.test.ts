import { jest } from '@jest/globals';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));
jest.mock('../src/index', () => ({
  bot: { telegram: { sendMessage: jest.fn(), sendPhoto: jest.fn() } },
}));
jest.mock('../src/lib/i18n', () => ({
  t: () => '',
}));
jest.mock('../src/controllers/send-active-stories', () => ({
  sendActiveStories: jest.fn(),
}));
jest.mock('../src/controllers/download-stories', () => ({
  mapStories: jest.fn(() => []),
}));
jest.mock('../src/lib', () => ({
  getEntityWithTempContact: jest.fn(),
}));
jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
}));

import { Userbot } from '../src/config/userbot';
import { getEntityWithTempContact } from '../src/lib';
import { addMonitor, getMonitor, removeMonitor } from '../src/db';
import { checkSingleMonitor, refreshMonitorUsername } from '../src/services/monitor-service';
import { Api } from 'telegram';
import bigInt from 'big-integer';

test('updates username using access hash when username changes', async () => {
  const row = addMonitor('tester', '100', 'oldname', '999', null);
  (getEntityWithTempContact as any).mockImplementation(() => {
    throw new Error('USERNAME_INVALID');
  });

  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(100), accessHash: bigInt(999), username: 'newname' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      return { stories: { stories: [] } };
    }
    if (query instanceof Api.photos.GetUserPhotos) {
      return { photos: [] } as any;
    }
    return null;
  });

  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  await checkSingleMonitor(row.id);

  const updated = getMonitor(row.id)!;
  expect(updated.target_username).toBe('newname');
  expect(invoke.mock.calls.some((c) => c[0] instanceof Api.users.GetUsers)).toBe(true);

  removeMonitor('tester', '100');
});

test('refreshMonitorUsername updates stored username when listing', async () => {
  (getEntityWithTempContact as any).mockReset();
  const row = addMonitor('tester', '200', 'oldname', '888', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(200), accessHash: bigInt(888), username: 'fresh' }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  await refreshMonitorUsername(row);

  const updated = getMonitor(row.id)!;
  expect(updated.target_username).toBe('fresh');
  expect(getEntityWithTempContact).not.toHaveBeenCalled();

  removeMonitor('tester', '200');
});
