import { jest } from '@jest/globals';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));
jest.mock('../src/index', () => ({
  bot: { telegram: { sendMessage: jest.fn(), sendPhoto: jest.fn() } },
}));
jest.mock('../src/lib/i18n', () => ({
  t: jest.fn(() => 'translated'),
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
jest.mock('../src/repositories/user-repository', () => ({
  findUserById: jest.fn(() => ({ language: 'en' })),
}));

import { Userbot } from '../src/config/userbot';
import { getEntityWithTempContact } from '../src/lib';
import { addMonitor, getMonitor, removeMonitor } from '../src/db';
import {
  addProfileMonitor,
  checkSingleMonitor,
  refreshMonitorUsername,
  removeProfileMonitor,
  listUserMonitors,
} from '../src/services/monitor-service';
import { bot } from '../src/index';
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
  (bot.telegram.sendMessage as jest.Mock).mockClear();

  await checkSingleMonitor(row.id);

  const updated = getMonitor(row.id)!;
  expect(updated.target_username).toBe('newname');
  const list = listUserMonitors('tester');
  expect(list[0].target_username).toBe('newname');
  expect(invoke.mock.calls.some((c) => c[0] instanceof Api.users.GetUsers)).toBe(true);
  expect(bot.telegram.sendMessage).toHaveBeenCalledWith('tester', 'translated');

  removeMonitor('tester', '100');
});

test('refreshMonitorUsername keeps /monitor list in sync', async () => {
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

  const list = listUserMonitors('tester');
  expect(list[0].target_username).toBe('fresh');
  expect(getEntityWithTempContact).not.toHaveBeenCalled();

  removeMonitor('tester', '200');
});

test('a removed username is cleared and announced so captions stop linking to a dead handle', async () => {
  const row = addMonitor('tester', '300', 'gonehandle', '777', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(300), accessHash: bigInt(777) }]; // no username any more
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  (bot.telegram.sendMessage as jest.Mock).mockClear();

  await refreshMonitorUsername(row);

  expect(getMonitor(row.id)!.target_username).toBeNull();
  expect(bot.telegram.sendMessage).toHaveBeenCalledWith('tester', 'translated');

  removeMonitor('tester', '300');
});

test('a phone-number label is not treated as a removed username', async () => {
  const row = addMonitor('tester', '400', '+15555550100', '666', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(400), accessHash: bigInt(666) }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  (bot.telegram.sendMessage as jest.Mock).mockClear();

  await refreshMonitorUsername(row);

  expect(getMonitor(row.id)!.target_username).toBe('+15555550100');
  expect(bot.telegram.sendMessage).not.toHaveBeenCalled();

  removeMonitor('tester', '400');
});

test('a handle carried only in the usernames list is picked up', async () => {
  const row = addMonitor('tester', '500', 'oldname', '555', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{
        id: bigInt(500),
        accessHash: bigInt(555),
        usernames: [
          { username: 'collectible', active: true, editable: false },
          { username: 'mainhandle', active: true, editable: true },
          { username: 'inactive', active: false, editable: true },
        ],
      }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  await refreshMonitorUsername(row);

  expect(getMonitor(row.id)!.target_username).toBe('mainhandle');

  removeMonitor('tester', '500');
});

test('a transient send failure keeps the stored username so the removal notice is retried', async () => {
  const row = addMonitor('tester', '600', 'flakyhandle', '444', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(600), accessHash: bigInt(444) }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  send.mockRejectedValueOnce(new Error('ETIMEDOUT'));

  await refreshMonitorUsername(row);
  expect(getMonitor(row.id)!.target_username).toBe('flakyhandle');
  expect(send).toHaveBeenCalledTimes(1);

  // An hour later the refresh runs again and this time the notice goes out.
  const realNow = Date.now;
  const later = realNow() + 60 * 60 * 1000 + 1;
  jest.spyOn(Date, 'now').mockImplementation(() => later);
  try {
    await refreshMonitorUsername(getMonitor(row.id)!);
  } finally {
    (Date.now as jest.Mock<any>).mockRestore();
  }
  expect(getMonitor(row.id)!.target_username).toBeNull();
  expect(send).toHaveBeenCalledTimes(2);

  removeMonitor('tester', '600');
});

test('a permanently undeliverable notice still records the removed username', async () => {
  const row = addMonitor('tester', '700', 'blockedhandle', '333', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(700), accessHash: bigInt(333) }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  send.mockRejectedValueOnce(
    Object.assign(new Error('403: Forbidden: bot was blocked by the user'), {
      response: { error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    }),
  );

  await refreshMonitorUsername(row);

  expect(getMonitor(row.id)!.target_username).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);

  removeMonitor('tester', '700');
});

test('without an access hash the id fallback only runs for username-not-found errors', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  (Userbot.getInstance as any).mockResolvedValue({ invoke: jest.fn() } as any);
  (bot.telegram.sendMessage as jest.Mock<any>).mockClear();

  // A transport failure must propagate without a second Telegram request.
  const flaky = addMonitor('tester', '800', 'stalehandle', null, null);
  lookup.mockReset();
  lookup.mockRejectedValue(new Error('TIMEOUT'));
  await refreshMonitorUsername(flaky);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledWith('stalehandle');
  expect(getMonitor(flaky.id)!.target_username).toBe('stalehandle');
  removeMonitor('tester', '800');

  // A dropped handle is retried by account id and the removal is recorded.
  const gone = addMonitor('tester', '900', 'gonehandle', null, null);
  lookup.mockReset();
  lookup
    .mockRejectedValueOnce(new Error('No user has "gonehandle" as username'))
    .mockResolvedValueOnce({ id: bigInt(900), accessHash: bigInt(222) });
  await refreshMonitorUsername(gone);
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(lookup).toHaveBeenNthCalledWith(2, '900');
  const updated = getMonitor(gone.id)!;
  expect(updated.target_username).toBeNull();
  expect(updated.target_access_hash).toBe('222');
  expect(bot.telegram.sendMessage).toHaveBeenCalledWith('tester', 'translated');
  removeMonitor('tester', '900');
});

test('a monitor added by a collectible alias keeps that alias and stays removable by it', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  const account = {
    id: bigInt(1000),
    accessHash: bigInt(111),
    usernames: [
      { username: 'Collectible', active: true, editable: false },
      { username: 'mainhandle', active: true, editable: true },
    ],
  };
  lookup.mockReset();
  lookup.mockResolvedValue(account);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();

  const row = await addProfileMonitor('tester', 'collectible');
  expect(row!.target_username).toBe('Collectible');

  // The hourly refresh sees the same handles and must not announce a change.
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) return [account];
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  await refreshMonitorUsername(getMonitor(row!.id)!);
  expect(getMonitor(row!.id)!.target_username).toBe('Collectible');
  expect(send).not.toHaveBeenCalled();

  // Removal is case-insensitive on the stored alias.
  expect(await removeProfileMonitor('tester', 'COLLECTIBLE')).toBe(true);
  expect(getMonitor(row!.id)).toBeUndefined();
});

test('removing by another handle of the same account resolves it to the target id', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  const row = addMonitor('tester', '1100', 'storedhandle', '222', null);

  lookup.mockReset();
  lookup.mockRejectedValue(new Error('No user has "nobody" as username'));
  expect(await removeProfileMonitor('tester', 'nobody')).toBe(false);
  expect(getMonitor(row.id)).toBeDefined();

  lookup.mockReset();
  lookup.mockResolvedValue({ id: bigInt(1100), accessHash: bigInt(222) });
  expect(await removeProfileMonitor('tester', '@otheralias')).toBe(true);
  expect(lookup).toHaveBeenCalledWith('otheralias');
  expect(getMonitor(row.id)).toBeUndefined();
});

test('a row without an access hash borrows one from a sibling monitor of the same account', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  lookup.mockReset();
  const withHash = addMonitor('other', '1200', 'shared', '333', null);
  const without = addMonitor('tester', '1200', 'shared', null, null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(1200), accessHash: bigInt(333), username: 'shared' }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  await refreshMonitorUsername(without);

  expect(getMonitor(without.id)!.target_access_hash).toBe('333');
  expect(invoke).toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();

  removeMonitor('other', '1200');
  removeMonitor('tester', '1200');
  void withHash;
});

test('without an access hash, a handle that is gone and an unresolvable id stops the monitor with a notice', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  const row = addMonitor('tester', '1300', 'vanished', null, null);
  (Userbot.getInstance as any).mockResolvedValue({ invoke: jest.fn() } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  lookup.mockReset();
  lookup
    .mockRejectedValueOnce(new Error('No user has "vanished" as username'))
    .mockRejectedValueOnce(new Error('Could not find the input entity for {"userId":"1300"}.'));

  await refreshMonitorUsername(row);

  expect(lookup).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledWith('tester', 'translated');
  expect(getMonitor(row.id)).toBeUndefined();
});

test('a transient failure while stopping an unresolvable monitor keeps the row for a retry', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  const row = addMonitor('tester', '1350', 'vanished2', null, null);
  (Userbot.getInstance as any).mockResolvedValue({ invoke: jest.fn() } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  send.mockRejectedValueOnce(new Error('ETIMEDOUT'));
  lookup.mockReset();
  lookup
    .mockRejectedValueOnce(new Error('No user has "vanished2" as username'))
    .mockRejectedValueOnce(new Error('Could not find the input entity for {"userId":"1350"}.'));

  await refreshMonitorUsername(row);

  expect(getMonitor(row.id)).toBeDefined();
  expect(getMonitor(row.id)!.target_username).toBe('vanished2');
  removeMonitor('tester', '1350');
});

test('a transient lookup failure while removing by alias propagates instead of reading as not found', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  const row = addMonitor('tester', '1400', 'kept', '444', null);
  lookup.mockReset();
  lookup.mockRejectedValue(new Error('TIMEOUT'));

  await expect(removeProfileMonitor('tester', 'somealias')).rejects.toThrow('TIMEOUT');
  expect(getMonitor(row.id)).toBeDefined();
  removeMonitor('tester', '1400');
});

test('a borrowed access hash that Telegram rejects is not persisted and the label is used instead', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  addMonitor('other', '1500', 'shared2', '1234567890', null);
  const without = addMonitor('tester', '1500', 'shared2', null, null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) throw new Error('USER_ID_INVALID');
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  lookup.mockReset();
  lookup.mockResolvedValue({ id: bigInt(1500), accessHash: bigInt(555), username: 'shared2' });
  (bot.telegram.sendMessage as jest.Mock<any>).mockClear();

  await refreshMonitorUsername(without);

  expect(invoke).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledWith('shared2');
  const updated = getMonitor(without.id)!;
  expect(updated.target_access_hash).toBe('555');
  expect(updated.target_username).toBe('shared2');
  expect(bot.telegram.sendMessage).not.toHaveBeenCalled();

  removeMonitor('other', '1500');
  removeMonitor('tester', '1500');
});

test('a notice failure after a borrowed hash was accepted keeps the hash and does not fall back', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  addMonitor('other', '1600', 'goner', '2222222222', null);
  const without = addMonitor('tester', '1600', 'goner', null, null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(1600), accessHash: bigInt(2222222222) }]; // username removed
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  lookup.mockReset();
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  send.mockRejectedValueOnce(new Error('ETIMEDOUT'));

  await refreshMonitorUsername(without);

  const updated = getMonitor(without.id)!;
  expect(updated.target_access_hash).toBe('2222222222');
  expect(updated.target_username).toBe('goner'); // retained for the retry
  expect(lookup).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);

  removeMonitor('other', '1600');
  removeMonitor('tester', '1600');
});
