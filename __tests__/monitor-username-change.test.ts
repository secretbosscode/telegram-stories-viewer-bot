import { jest } from '@jest/globals';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn(), isHealthy: jest.fn(() => true) },
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
// Monitoring output only reaches an entitled subscriber; every test here is
// about the notice itself, so the subscriber is premium unless a test says
// otherwise.
jest.mock('../src/services/premium-service', () => ({
  isUserPremium: jest.fn(() => true),
}));

import { Userbot } from '../src/config/userbot';
import { getEntityWithTempContact } from '../src/lib';
import {
  addMonitor,
  deletePendingUsernameNoticesForMonitor,
  getMonitor,
  listAllMonitors,
  listPendingUsernameNotices,
  removeMonitor,
  setBotBlocked,
  updateMonitorUsername,
  upsertPendingUsernameNotice,
} from '../src/db';

/** The outbox is shared by every test in this file; start each replay clean. */
function clearOutbox(): void {
  for (const stale of listPendingUsernameNotices()) {
    deletePendingUsernameNoticesForMonitor(stale.monitor_id);
  }
}

function pendingFor(monitorId: number) {
  return listPendingUsernameNotices().find((p) => p.monitor_id === monitorId);
}
import {
  addProfileMonitor,
  checkSingleMonitor,
  forceCheckMonitors,
  refreshMonitorUsername,
  removeProfileMonitor,
  replayPendingUsernameNotices,
  listUserMonitors,
  stopMonitorLoop,
} from '../src/services/monitor-service';
import { isUserPremium } from '../src/services/premium-service';
import { t } from '../src/lib/i18n';
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

test('a case-only spelling change is recorded quietly and keeps a pending notice', async () => {
  clearOutbox();
  const row = addMonitor('tester', '450', 'oldhandle', '456', null);
  let reported = 'newhandle';
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(450), accessHash: bigInt(456), username: reported }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  send.mockRejectedValueOnce(new Error('ETIMEDOUT'));

  // A real change whose notice could not be delivered: it is still owed.
  await refreshMonitorUsername(row);
  expect(getMonitor(row.id)!.target_username).toBe('newhandle');
  const owed = pendingFor(row.id);
  expect(owed?.text).toBe('translated');

  // An hour later Telegram reports the same handle spelled differently.
  reported = 'NewHandle';
  const later = Date.now() + 60 * 60 * 1000 + 1;
  jest.spyOn(Date, 'now').mockImplementation(() => later);
  try {
    await refreshMonitorUsername(getMonitor(row.id)!);
  } finally {
    (Date.now as jest.Mock<any>).mockRestore();
  }

  // Telegram's spelling wins, but the same handle is not a change worth
  // announcing, so nothing more is sent — and the notice already owed for the
  // real change is still owed, unchanged.
  expect(getMonitor(row.id)!.target_username).toBe('NewHandle');
  expect(send).toHaveBeenCalledTimes(1);
  const stillOwed = pendingFor(row.id);
  expect(stillOwed?.attempt).toBe(owed?.attempt);
  expect(stillOwed?.text).toBe('translated');

  removeMonitor('tester', '450');
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

test('a transient send failure keeps the label and leaves the notice in the outbox', async () => {
  clearOutbox();
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

  // What Telegram reports is recorded straight away; the outbox, not the
  // label, is what remembers that nobody has been told yet.
  expect(getMonitor(row.id)!.target_username).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  const owed = pendingFor(row.id);
  expect(owed?.text).toBe('translated');
  expect(owed!.last_attempt_at).toBeGreaterThan(0);

  // The next cycle replays it, and the row goes once it is delivered.
  send.mockResolvedValueOnce({ message_id: 1 } as any);
  await replayPendingUsernameNotices();
  expect(send).toHaveBeenCalledTimes(2);
  expect(getMonitor(row.id)!.target_username).toBeNull();
  expect(pendingFor(row.id)).toBeUndefined();

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
  // Nothing will ever deliver it, so the row goes rather than being replayed
  // every cycle at a chat that is gone.
  expect(pendingFor(row.id)).toBeUndefined();

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

  // A channel or group that happens to share the numeric id must not match.
  lookup.mockReset();
  lookup.mockResolvedValue({ className: 'Channel', id: bigInt(1100), accessHash: bigInt(1) });
  expect(await removeProfileMonitor('tester', '@somechannel')).toBe(false);
  expect(getMonitor(row.id)).toBeDefined();

  lookup.mockReset();
  lookup.mockResolvedValue(new Api.User({ id: bigInt(1100), accessHash: bigInt(222) } as any));
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
  // The observation is recorded whatever the send does; the retry lives in
  // the outbox instead.
  expect(updated.target_username).toBeNull();
  expect(pendingFor(without.id)?.text).toBe('translated');
  expect(lookup).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);

  removeMonitor('other', '1600');
  removeMonitor('tester', '1600');
});

test('a transient failure while probing with a borrowed hash propagates and keeps the row', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  addMonitor('other', '1700', 'flap', '3333333333', null);
  const without = addMonitor('tester', '1700', 'flap', null, null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) throw new Error('TIMEOUT');
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  lookup.mockReset();
  (bot.telegram.sendMessage as jest.Mock<any>).mockClear();

  expect(await refreshMonitorUsername(without)).toBe(true);

  const kept = getMonitor(without.id)!;
  expect(kept.target_username).toBe('flap');
  expect(kept.target_access_hash).toBeNull();
  expect(lookup).not.toHaveBeenCalled();
  expect(bot.telegram.sendMessage).not.toHaveBeenCalled();

  removeMonitor('other', '1700');
  removeMonitor('tester', '1700');
});

test('a monitor stopped during the refresh is not fetched for or delivered to', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  const row = addMonitor('tester', '1800', 'gonegone', null, null);
  const invoke = jest.fn(async () => ({ stories: { stories: [] } }));
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  (bot.telegram.sendMessage as jest.Mock<any>).mockClear();
  lookup.mockReset();
  lookup
    .mockRejectedValueOnce(new Error('No user has "gonegone" as username'))
    .mockRejectedValueOnce(new Error('Could not find the input entity for {"userId":"1800"}.'));

  await checkSingleMonitor(row.id);

  expect(getMonitor(row.id)).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
  expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
});

test('every distinct sibling hash is tried before falling back to the label', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  addMonitor('other1', '1900', 'multi', '1111111111', null); // stale
  addMonitor('other2', '1900', 'multi', '2222222222', null); // valid, newer row
  const without = addMonitor('tester', '1900', 'multi', null, null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      const hash = String((query.id[0] as any).accessHash);
      if (hash === '2222222222') {
        return [{ id: bigInt(1900), accessHash: bigInt(2222222222), username: 'multi' }];
      }
      throw Object.assign(new Error('USER_ID_INVALID'), { errorMessage: 'USER_ID_INVALID' });
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  lookup.mockReset();

  await refreshMonitorUsername(without);

  expect(getMonitor(without.id)!.target_access_hash).toBe('2222222222');
  expect(lookup).not.toHaveBeenCalled();
  const probedHashes = invoke.mock.calls.map((c: any) => String(c[0].id[0].accessHash));
  expect(probedHashes).toEqual(['2222222222']); // newest row first, so the valid one wins outright

  removeMonitor('other1', '1900');
  removeMonitor('other2', '1900');
  removeMonitor('tester', '1900');
});

test('a stale newest sibling hash is skipped in favour of an older valid one', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  addMonitor('other1', '2000', 'multi2', '3333333333', null); // valid, older row
  addMonitor('other2', '2000', 'multi2', '4444444444', null); // stale, newer row
  const without = addMonitor('tester', '2000', 'multi2', null, null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      const hash = String((query.id[0] as any).accessHash);
      if (hash === '3333333333') {
        return [{ id: bigInt(2000), accessHash: bigInt(3333333333), username: 'multi2' }];
      }
      throw Object.assign(new Error('USER_ID_INVALID'), { errorMessage: 'USER_ID_INVALID' });
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  lookup.mockReset();

  await refreshMonitorUsername(without);

  expect(getMonitor(without.id)!.target_access_hash).toBe('3333333333');
  expect(lookup).not.toHaveBeenCalled();
  const probedHashes = invoke.mock.calls.map((c: any) => String(c[0].id[0].accessHash));
  expect(probedHashes).toEqual(['4444444444', '3333333333']);

  removeMonitor('other1', '2000');
  removeMonitor('other2', '2000');
  removeMonitor('tester', '2000');
});

test('monitoring an account again through another of its handles reports it as already monitored', async () => {
  const lookup = getEntityWithTempContact as jest.Mock<any>;
  const account = {
    id: bigInt(2100),
    accessHash: bigInt(555),
    username: 'mainname',
    usernames: [
      { username: 'altname', active: true, editable: false },
      { username: 'mainname', active: true, editable: true },
    ],
  };
  lookup.mockReset();
  lookup.mockResolvedValue(account);

  const first = await addProfileMonitor('tester', 'altname');
  expect(first!.target_username).toBe('altname');

  const second = await addProfileMonitor('tester', 'mainname');
  expect(second).toBeNull();
  expect(listUserMonitors('tester').filter((m) => m.target_id === '2100')).toHaveLength(1);

  removeMonitor('tester', '2100');
});

test('a notice send that never settles leaves the recorded label in place', async () => {
  const row = addMonitor('tester', '2200', 'hanging', '777', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) return [{ id: bigInt(2200), accessHash: bigInt(777) }];
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  send.mockReturnValueOnce(new Promise(() => {})); // never settles
  process.env.MONITOR_NOTICE_TIMEOUT_MS = '50';
  try {
    // The deadline only bounds the wait; it must not decide that the send
    // failed, because the message may still be delivered.
    expect(await refreshMonitorUsername(row)).toBe(true);
  } finally {
    delete process.env.MONITOR_NOTICE_TIMEOUT_MS;
  }
  expect(getMonitor(row.id)!.target_username).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  removeMonitor('tester', '2200');
});

test('a notice that times out and then succeeds late is not sent a second time', async () => {
  clearOutbox();
  const row = addMonitor('tester', '2400', 'slowsend', '2400111', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(2400), accessHash: bigInt(2400111) }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  let resolveSend: (value: unknown) => void = () => {};
  send.mockReturnValueOnce(new Promise((resolve) => { resolveSend = resolve; }));
  process.env.MONITOR_NOTICE_TIMEOUT_MS = '50';
  try {
    await refreshMonitorUsername(row);
  } finally {
    delete process.env.MONITOR_NOTICE_TIMEOUT_MS;
  }
  expect(getMonitor(row.id)!.target_username).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  // Abandoned at the deadline, not failed: the row waits for the real outcome.
  expect(pendingFor(row.id)?.text).toBe('translated');

  // Telegram accepted the abandoned message after all, so the intent is
  // discharged and the row goes.
  resolveSend({ message_id: 1 });
  await new Promise((r) => setImmediate(r));
  expect(getMonitor(row.id)!.target_username).toBeNull();
  expect(pendingFor(row.id)).toBeUndefined();

  // Nothing is left for the next cycle to replay, so the subscriber is not
  // told the same thing twice.
  await replayPendingUsernameNotices();
  expect(send).toHaveBeenCalledTimes(1);

  removeMonitor('tester', '2400');
});

test('a notice that times out and then fails late keeps the row for the next replay', async () => {
  clearOutbox();
  const row = addMonitor('tester', '2500', 'latefail', '2500111', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(2500), accessHash: bigInt(2500111) }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  let rejectSend: (error: Error) => void = () => {};
  send.mockReturnValueOnce(new Promise((_, reject) => { rejectSend = reject; }));
  process.env.MONITOR_NOTICE_TIMEOUT_MS = '50';
  try {
    await refreshMonitorUsername(row);
  } finally {
    delete process.env.MONITOR_NOTICE_TIMEOUT_MS;
  }
  expect(getMonitor(row.id)!.target_username).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  const attempt = pendingFor(row.id)?.attempt;
  expect(attempt).toBeTruthy();

  // The abandoned send fails late. Nothing is rolled back: the label stands
  // and the row it wrote is still owed.
  rejectSend(new Error('ETIMEDOUT'));
  await new Promise((r) => setImmediate(r));
  expect(getMonitor(row.id)!.target_username).toBeNull();
  expect(pendingFor(row.id)?.attempt).toBe(attempt);

  send.mockResolvedValueOnce({ message_id: 1 } as any);
  await replayPendingUsernameNotices();
  expect(send).toHaveBeenCalledTimes(2);
  expect(pendingFor(row.id)).toBeUndefined();

  removeMonitor('tester', '2500');
});

test('a notice that times out and then fails permanently drops the row', async () => {
  clearOutbox();
  const row = addMonitor('tester', '2900', 'lategone', '2900111', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(2900), accessHash: bigInt(2900111) }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  let rejectSend: (error: Error) => void = () => {};
  send.mockReturnValueOnce(new Promise((_, reject) => { rejectSend = reject; }));
  process.env.MONITOR_NOTICE_TIMEOUT_MS = '50';
  try {
    await refreshMonitorUsername(row);
  } finally {
    delete process.env.MONITOR_NOTICE_TIMEOUT_MS;
  }
  expect(pendingFor(row.id)).toBeDefined();

  rejectSend(
    Object.assign(new Error('403: Forbidden: bot was blocked by the user'), {
      response: { error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    }),
  );
  await new Promise((r) => setImmediate(r));
  // Undeliverable for good: the row goes and the label stays as observed.
  expect(pendingFor(row.id)).toBeUndefined();
  expect(getMonitor(row.id)!.target_username).toBeNull();

  removeMonitor('tester', '2900');
});

test('a late send failure does not overwrite a username recorded by a later refresh', async () => {
  clearOutbox();
  const row = addMonitor('tester', '2300', 'first', '888', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) return [{ id: bigInt(2300), accessHash: bigInt(888) }];
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  let rejectSend: (e: Error) => void = () => {};
  send.mockReturnValueOnce(new Promise((_, reject) => { rejectSend = reject; }));

  const pending = refreshMonitorUsername(row); // clears the username, send still in flight
  await new Promise((r) => setImmediate(r));
  expect(getMonitor(row.id)!.target_username).toBeNull();

  // A later observation lands while the first send is still pending.
  updateMonitorUsername(row.id, 'newer');
  rejectSend(new Error('ETIMEDOUT'));
  await pending;

  // A failing send touches no label at all any more.
  expect(getMonitor(row.id)!.target_username).toBe('newer');
  removeMonitor('tester', '2300');
});

test('an observation made while a notice is in flight supersedes the pending row', async () => {
  clearOutbox();
  const row = addMonitor('tester', '2600', 'firsthandle', '2600111', null);
  let reported = 'secondhandle';
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(2600), accessHash: bigInt(2600111), username: reported }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  let resolveSend: (value: unknown) => void = () => {};
  send.mockReturnValueOnce(new Promise((resolve) => { resolveSend = resolve; }));
  process.env.MONITOR_NOTICE_TIMEOUT_MS = '50';
  try {
    await refreshMonitorUsername(row);
  } finally {
    delete process.env.MONITOR_NOTICE_TIMEOUT_MS;
  }
  expect(getMonitor(row.id)!.target_username).toBe('secondhandle');
  expect(send).toHaveBeenCalledTimes(1);
  const firstAttempt = pendingFor(row.id)?.attempt;
  expect(firstAttempt).toBeTruthy();

  // An hour later the account has changed handle again while that first
  // notice is still pending. The label is recorded regardless, and the row is
  // replaced by the newer notice under a fresh attempt token; no second send
  // starts alongside the pending one.
  const hour = 60 * 60 * 1000 + 1;
  reported = 'later';
  const secondAt = Date.now() + hour;
  jest.spyOn(Date, 'now').mockImplementation(() => secondAt);
  // The clock jump that gets past the hourly refresh gate also ages the
  // in-flight entry past its default abandonment bound; declare one that
  // covers the jump, since the expiry case has a test of its own below.
  process.env.MONITOR_NOTICE_INFLIGHT_MAX_MS = String(2 * hour);
  try {
    await refreshMonitorUsername(getMonitor(row.id)!);
  } finally {
    (Date.now as jest.Mock<any>).mockRestore();
    delete process.env.MONITOR_NOTICE_INFLIGHT_MAX_MS;
  }
  expect(getMonitor(row.id)!.target_username).toBe('later');
  expect(send).toHaveBeenCalledTimes(1);
  const superseding = pendingFor(row.id);
  expect(superseding?.attempt).not.toBe(firstAttempt);
  expect(superseding?.last_attempt_at).toBeNull();

  // The first send finally succeeds. Its deletes are scoped to its own
  // attempt, so the notice recorded since survives.
  resolveSend({ message_id: 1 });
  await new Promise((r) => setImmediate(r));
  expect(pendingFor(row.id)?.attempt).toBe(superseding?.attempt);

  // And the next cycle delivers it.
  send.mockResolvedValueOnce({ message_id: 2 } as any);
  await replayPendingUsernameNotices();
  expect(send).toHaveBeenCalledTimes(2);
  expect(pendingFor(row.id)).toBeUndefined();

  removeMonitor('tester', '2600');
});

test('a second observation whose first send fails late still leaves the newer row owed', async () => {
  clearOutbox();
  const row = addMonitor('tester', '3200', 'firstlabel', '3200111', null);
  let reported: string | null = 'secondlabel';
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(3200), accessHash: bigInt(3200111), username: reported }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  let rejectFirst: (error: Error) => void = () => {};
  send.mockReturnValueOnce(new Promise((_, reject) => { rejectFirst = reject; }));
  process.env.MONITOR_NOTICE_TIMEOUT_MS = '50';
  try {
    await refreshMonitorUsername(row);
  } finally {
    delete process.env.MONITOR_NOTICE_TIMEOUT_MS;
  }
  expect(getMonitor(row.id)!.target_username).toBe('secondlabel');
  const firstAttempt = pendingFor(row.id)?.attempt;
  expect(firstAttempt).toBeTruthy();

  // An hour later the handle changes again. The first send has outlived the
  // in-flight bound, so this observation is sent in its own right; that send
  // stays pending too, so the outbox holds its row.
  reported = 'thirdlabel';
  const later = Date.now() + 60 * 60 * 1000 + 1;
  jest.spyOn(Date, 'now').mockImplementation(() => later);
  process.env.MONITOR_NOTICE_INFLIGHT_MAX_MS = '1';
  process.env.MONITOR_NOTICE_TIMEOUT_MS = '50';
  send.mockReturnValueOnce(new Promise(() => {})); // still in flight
  try {
    await refreshMonitorUsername(getMonitor(row.id)!);
  } finally {
    (Date.now as jest.Mock<any>).mockRestore();
    delete process.env.MONITOR_NOTICE_INFLIGHT_MAX_MS;
    delete process.env.MONITOR_NOTICE_TIMEOUT_MS;
  }
  expect(getMonitor(row.id)!.target_username).toBe('thirdlabel');
  expect(send).toHaveBeenCalledTimes(2);
  const secondAttempt = pendingFor(row.id)?.attempt;
  expect(secondAttempt).toBeTruthy();
  expect(secondAttempt).not.toBe(firstAttempt);

  // The abandoned first send finally fails. It may only clean up after
  // itself: the notice the second observation is still owed must survive.
  rejectFirst(new Error('ETIMEDOUT'));
  await new Promise((r) => setImmediate(r));
  const stillPending = pendingFor(row.id);
  expect(stillPending?.attempt).toBe(secondAttempt);
  expect(stillPending?.text).toBe('translated');
  expect(getMonitor(row.id)!.target_username).toBe('thirdlabel');

  removeMonitor('tester', '3200');
});

test('a handle acquired again is announced and supersedes the pending removal notice', async () => {
  clearOutbox();
  const row = addMonitor('tester', '3600', 'goneforawhile', '3600111', null);
  let reported: string | null = null;
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(3600), accessHash: bigInt(3600111), username: reported }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockReset();
  send.mockResolvedValue(undefined);
  send.mockRejectedValueOnce(new Error('ETIMEDOUT'));

  await refreshMonitorUsername(row);
  expect(getMonitor(row.id)!.target_username).toBeNull();
  const owed = pendingFor(row.id);
  expect(owed).toBeDefined();

  // An hour later the account has a handle again. The transition is announced
  // rather than recorded silently: the pending "dropped their username" notice
  // describes a state the account has left, and only an announcement of its own
  // can correct that if the stale one was already replayed.
  reported = 'backagain';
  (t as jest.Mock).mockClear();
  const later = Date.now() + 60 * 60 * 1000 + 1;
  jest.spyOn(Date, 'now').mockImplementation(() => later);
  try {
    await refreshMonitorUsername(getMonitor(row.id)!);
  } finally {
    (Date.now as jest.Mock<any>).mockRestore();
  }
  expect(getMonitor(row.id)!.target_username).toBe('backagain');
  expect((t as jest.Mock).mock.calls.map((c: any[]) => c[1])).toContain(
    'monitor.usernameAcquired',
  );
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith('tester', 'translated');
  // The observation replaced the owed row under a fresh attempt token, and the
  // send that followed it settled, so nothing is left owed.
  expect(pendingFor(row.id)).toBeUndefined();

  send.mockReset();
  removeMonitor('tester', '3600');
});

test('a phone-number label that gains a handle is announced as a change', async () => {
  clearOutbox();
  const row = addMonitor('tester', '3610', '+15555550111', '3610111', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(3610), accessHash: bigInt(3610111), username: 'phonehandle' }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockReset();
  send.mockResolvedValue(undefined);
  (t as jest.Mock).mockClear();

  await refreshMonitorUsername(row);

  // A '+…' label is a label like any other, so this is a change, not an
  // acquisition: the subscriber is told what the target used to be called.
  expect(getMonitor(row.id)!.target_username).toBe('phonehandle');
  expect(send).toHaveBeenCalledWith('tester', 'translated');
  const changed = (t as jest.Mock).mock.calls.find(
    (c: any[]) => c[1] === 'monitor.usernameChanged',
  );
  expect(changed).toBeDefined();
  expect((changed as any[])[2]).toEqual({ old: '+15555550111', user: '@phonehandle' });
  expect(
    (t as jest.Mock).mock.calls.map((c: any[]) => c[1]),
  ).not.toContain('monitor.usernameAcquired');
  expect(pendingFor(row.id)).toBeUndefined();

  send.mockReset();
  removeMonitor('tester', '3610');
});

test('a notice pending past the deadline is held in the outbox until the send settles', async () => {
  clearOutbox();
  const row = addMonitor('tester', '2800', 'outboxhandle', '2800111', null);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(2800), accessHash: bigInt(2800111) }]; // username gone
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  let resolveSend: (value: unknown) => void = () => {};
  send.mockReturnValueOnce(new Promise((resolve) => { resolveSend = resolve; }));
  process.env.MONITOR_NOTICE_TIMEOUT_MS = '50';
  try {
    await refreshMonitorUsername(row);
  } finally {
    delete process.env.MONITOR_NOTICE_TIMEOUT_MS;
  }
  // The label is stored, so nothing would ever re-observe this change; the
  // outbox row is what survives a restart at this exact point.
  expect(getMonitor(row.id)!.target_username).toBeNull();
  const pending = listPendingUsernameNotices().filter((p) => p.monitor_id === row.id);
  expect(pending).toHaveLength(1);
  expect(pending[0].telegram_id).toBe('tester');
  expect(pending[0].text).toBe('translated');
  // Claimed before the send, so a row whose send hangs rotates behind the
  // untried ones instead of filling every batch.
  expect(pending[0].last_attempt_at).toBeGreaterThan(0);

  resolveSend({ message_id: 1 });
  await new Promise((r) => setImmediate(r));
  expect(listPendingUsernameNotices().some((p) => p.monitor_id === row.id)).toBe(false);

  removeMonitor('tester', '2800');
});

test('an observation for a subscriber who blocked the bot is recorded and left owed', async () => {
  clearOutbox();
  const row = addMonitor('blocker', '3700', 'blockedside', '3700111', null);
  setBotBlocked('blocker', true);
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(3700), accessHash: bigInt(3700111) }];
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();

  await refreshMonitorUsername(row);
  expect(send).not.toHaveBeenCalled();
  expect(getMonitor(row.id)!.target_username).toBeNull();
  expect(pendingFor(row.id)?.text).toBe('translated');

  // Replay keeps it too: they may unblock, and removeMonitor takes the row
  // with it if they never do.
  await replayPendingUsernameNotices();
  expect(send).not.toHaveBeenCalled();
  expect(pendingFor(row.id)).toBeDefined();

  // Once they unblock, the next cycle delivers it.
  setBotBlocked('blocker', false);
  send.mockResolvedValueOnce({ message_id: 1 } as any);
  await replayPendingUsernameNotices();
  expect(send).toHaveBeenCalledWith('blocker', 'translated');
  expect(pendingFor(row.id)).toBeUndefined();

  removeMonitor('blocker', '3700');
});

test('a notice recorded before a restart is replayed on the next cycle', async () => {
  clearOutbox();
  const row = addMonitor('tester', '3000', 'replayhandle', '3000111', null);
  const send = bot.telegram.sendMessage as jest.Mock<any>;

  // The process died after the label write; only the outbox row remains.
  send.mockClear();
  send.mockResolvedValueOnce({ message_id: 1 } as any);
  upsertPendingUsernameNotice(row.id, 'tester', 'restart notice', Date.now());
  await replayPendingUsernameNotices();
  expect(send).toHaveBeenCalledWith('tester', 'restart notice');
  expect(listPendingUsernameNotices().some((p) => p.monitor_id === row.id)).toBe(false);

  // A transient failure keeps the row for the next cycle.
  send.mockClear();
  send.mockRejectedValueOnce(new Error('ETIMEDOUT'));
  upsertPendingUsernameNotice(row.id, 'tester', 'retry notice', Date.now());
  await replayPendingUsernameNotices();
  expect(send).toHaveBeenCalledTimes(1);
  const retried = pendingFor(row.id);
  expect(retried?.text).toBe('retry notice');
  // Claimed before the send, so the failed row rotates behind untried ones.
  expect(retried?.last_attempt_at).toBeGreaterThan(0);
  deletePendingUsernameNoticesForMonitor(row.id);

  // A row whose monitor is gone is dropped without sending anything.
  send.mockClear();
  upsertPendingUsernameNotice(999999, 'tester', 'ghost notice', Date.now());
  await replayPendingUsernameNotices();
  expect(send).not.toHaveBeenCalled();
  expect(listPendingUsernameNotices().some((p) => p.monitor_id === 999999)).toBe(false);

  // A week-old notice describes a handle that has probably changed again.
  send.mockClear();
  upsertPendingUsernameNotice(
    row.id,
    'tester',
    'stale notice',
    Date.now() - 8 * 24 * 60 * 60 * 1000,
  );
  await replayPendingUsernameNotices();
  expect(send).not.toHaveBeenCalled();
  expect(listPendingUsernameNotices().some((p) => p.monitor_id === row.id)).toBe(false);

  removeMonitor('tester', '3000');
});

test('removing a monitor drops the username notice it still owed', () => {
  const row = addMonitor('tester', '3100', 'cleanuphandle', '3100111', null);
  upsertPendingUsernameNotice(row.id, 'tester', 'owed notice', Date.now());
  expect(listPendingUsernameNotices().some((p) => p.monitor_id === row.id)).toBe(true);

  removeMonitor('tester', '3100');

  expect(listPendingUsernameNotices().some((p) => p.monitor_id === row.id)).toBe(false);
});

test('a replay that keeps failing rotates behind the rows nothing has tried yet', async () => {
  clearOutbox();
  const oldest = addMonitor('tester', '3300', 'oldest', '3300111', null);
  const middle = addMonitor('tester', '3301', 'middle', '3301111', null);
  const newest = addMonitor('tester', '3302', 'newest', '3302111', null);
  const base = Date.now() - 60 * 60 * 1000;
  upsertPendingUsernameNotice(oldest.id, 'tester', 'oldest notice', base);
  upsertPendingUsernameNotice(middle.id, 'tester', 'middle notice', base + 1000);
  upsertPendingUsernameNotice(newest.id, 'tester', 'newest notice', base + 2000);

  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  send.mockRejectedValueOnce(new Error('ETIMEDOUT'));
  // Only one row fits in this cycle's batch, and its send fails.
  process.env.MONITOR_NOTICE_REPLAY_BATCH = '1';
  try {
    await replayPendingUsernameNotices();
  } finally {
    delete process.env.MONITOR_NOTICE_REPLAY_BATCH;
  }
  expect(send.mock.calls.map((c: any[]) => c[1])).toEqual(['oldest notice']);
  const tried = listPendingUsernameNotices().find((p) => p.monitor_id === oldest.id);
  expect(tried?.last_attempt_at).toBeGreaterThan(0);

  // Next cycle the untried rows go first; ordering by age alone let the
  // failing row fill every batch while the others aged out unsent.
  send.mockClear();
  await replayPendingUsernameNotices();
  expect(send.mock.calls.map((c: any[]) => c[1])).toEqual([
    'middle notice',
    'newest notice',
    'oldest notice',
  ]);
  expect(listPendingUsernameNotices()).toHaveLength(0);

  removeMonitor('tester', '3300');
  removeMonitor('tester', '3301');
  removeMonitor('tester', '3302');
});

test('a pending notice is held, not sent, while its subscriber is no longer entitled', async () => {
  clearOutbox();
  const row = addMonitor('lapsed-user', '3400', 'lapsedhandle', '3400111', null);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  upsertPendingUsernameNotice(row.id, 'lapsed-user', 'lapsed notice', Date.now());

  // Replay runs before the cycle reconciles entitlements, so it has to make
  // the same judgement itself.
  (isUserPremium as jest.Mock).mockReturnValue(false);
  try {
    await replayPendingUsernameNotices();
  } finally {
    (isUserPremium as jest.Mock).mockReturnValue(true);
  }
  expect(send).not.toHaveBeenCalled();
  // The row stays: the reconciliation that follows removes the monitor and
  // takes the owed notice with it, and a subscriber who renews is still told.
  expect(listPendingUsernameNotices().find((p) => p.monitor_id === row.id)?.text).toBe(
    'lapsed notice',
  );

  await replayPendingUsernameNotices();
  expect(send).toHaveBeenCalledWith('lapsed-user', 'lapsed notice');
  expect(listPendingUsernameNotices().some((p) => p.monitor_id === row.id)).toBe(false);

  removeMonitor('lapsed-user', '3400');
});

test('pending notices are replayed even while the userbot connection is unhealthy', async () => {
  clearOutbox();
  const row = addMonitor('tester', '3500', 'offlinehandle', '3500111', null);
  const invoke = jest.fn(async () => ({ stories: { stories: [] } }));
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockClear();
  upsertPendingUsernameNotice(row.id, 'tester', 'outage notice', Date.now());

  (Userbot as any).isHealthy.mockReturnValue(false);
  try {
    // The cycle still gives up on the targets, but a notice needing only the
    // bot API must not wait for the userbot to come back and age out.
    expect(await forceCheckMonitors()).toBe(0);
  } finally {
    (Userbot as any).isHealthy.mockReturnValue(true);
    stopMonitorLoop();
  }
  expect(send).toHaveBeenCalledWith('tester', 'outage notice');
  expect(invoke).not.toHaveBeenCalled();
  expect(listPendingUsernameNotices().some((p) => p.monitor_id === row.id)).toBe(false);

  removeMonitor('tester', '3500');
});

test('a leftover removal notice is superseded and the regained handle announced instead', async () => {
  clearOutbox();
  // forceCheckMonitors walks every monitor; leave it only this one to check.
  for (const stale of listAllMonitors()) removeMonitor(stale.telegram_id, stale.target_id);
  // Restart state: the label was already stored as null and only the outbox
  // row still remembers that the subscriber has to be told about it.
  const row = addMonitor('tester', '3800', null, '3800111', null);
  upsertPendingUsernameNotice(row.id, 'tester', 'removal notice', Date.now());

  // Meanwhile the account has acquired a handle again.
  const invoke = jest.fn(async (query: any) => {
    if (query instanceof Api.users.GetUsers) {
      return [{ id: bigInt(3800), accessHash: bigInt(3800111), username: 'backagain' }];
    }
    if (query instanceof Api.stories.GetPeerStories) {
      return { stories: { stories: [] } };
    }
    return null;
  });
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockReset();

  try {
    await forceCheckMonitors();
  } finally {
    stopMonitorLoop();
  }

  // On a healthy cycle the replay runs after the target loop, so the refresh
  // has already superseded this row: its observation replaced the leftover
  // text under a fresh attempt token and announced the regained handle, so the
  // obsolete removal notice is never sent and the post-loop replay finds
  // nothing left to send.
  expect(send.mock.calls.map((c: any[]) => c[1])).not.toContain('removal notice');
  expect(send.mock.calls.map((c: any[]) => c[1])).toContain('translated');
  expect(pendingFor(row.id)).toBeUndefined();
  expect(getMonitor(row.id)!.target_username).toBe('backagain');

  send.mockReset();
  removeMonitor('tester', '3800');
});

test('the replay cap counts attempts, so held rows do not starve deliverable ones', async () => {
  clearOutbox();
  const held = addMonitor('blocker', '3900', 'heldrow', '3900111', null);
  const deliverable = addMonitor('tester', '3901', 'deliverablerow', '3901111', null);
  setBotBlocked('blocker', true);
  const base = Date.now() - 60 * 60 * 1000;
  // The held row is the older one, so it comes first in the replay order.
  upsertPendingUsernameNotice(held.id, 'blocker', 'held notice', base);
  upsertPendingUsernameNotice(deliverable.id, 'tester', 'deliverable notice', base + 1000);

  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockReset();
  process.env.MONITOR_NOTICE_REPLAY_BATCH = '1';
  try {
    await replayPendingUsernameNotices();
  } finally {
    delete process.env.MONITOR_NOTICE_REPLAY_BATCH;
  }

  // A fixed slice of the ordered list would have selected only the blocked
  // row, cycle after cycle, without ever touching its last_attempt_at, and
  // the deliverable row behind it would have waited until it aged out.
  expect(send.mock.calls.map((c: any[]) => c[1])).toEqual(['deliverable notice']);
  expect(pendingFor(held.id)?.text).toBe('held notice');
  expect(pendingFor(deliverable.id)).toBeUndefined();

  setBotBlocked('blocker', false);
  removeMonitor('blocker', '3900');
  removeMonitor('tester', '3901');
});

test('the replay stops once it has spent its time budget and leaves the rest for the next cycle', async () => {
  clearOutbox();
  const first = addMonitor('tester', '4200', 'firstbudget', '4200111', null);
  const second = addMonitor('tester', '4201', 'secondbudget', '4201111', null);
  const base = Date.now();
  upsertPendingUsernameNotice(first.id, 'tester', 'first budget notice', base - 60 * 60 * 1000);
  upsertPendingUsernameNotice(second.id, 'tester', 'second budget notice', base - 59 * 60 * 1000);

  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockReset();
  // Deterministic elapsed time: the clock only moves once a notice has gone
  // out, so the check before the first row sees nothing spent (a budget of 0
  // still allows one attempt) and the check before the second one stops it.
  let elapsed = 0;
  send.mockImplementation(async () => {
    elapsed = 5000;
    return undefined;
  });
  jest.spyOn(Date, 'now').mockImplementation(() => base + elapsed);
  process.env.MONITOR_NOTICE_REPLAY_BUDGET_MS = '0';
  try {
    await replayPendingUsernameNotices();
  } finally {
    delete process.env.MONITOR_NOTICE_REPLAY_BUDGET_MS;
    (Date.now as jest.Mock<any>).mockRestore();
  }

  // The attempt cap alone bounds the number of sends, not the time they take;
  // a backlog of slow sends would otherwise stretch the cycle far past it.
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls.map((c: any[]) => c[1])).toEqual(['first budget notice']);
  expect(pendingFor(first.id)).toBeUndefined();
  expect(pendingFor(second.id)?.text).toBe('second budget notice');
  // Left untouched, so the next cycle picks it up as an untried row.
  expect(pendingFor(second.id)?.last_attempt_at).toBeNull();

  send.mockReset();
  removeMonitor('tester', '4200');
  removeMonitor('tester', '4201');
});

test('a row deleted while an earlier notice was being sent is not sent from the stale snapshot', async () => {
  clearOutbox();
  const first = addMonitor('tester', '4000', 'firstrow', '4000111', null);
  const second = addMonitor('tester', '4001', 'secondrow', '4001111', null);
  const base = Date.now() - 60 * 60 * 1000;
  upsertPendingUsernameNotice(first.id, 'tester', 'first notice', base);
  upsertPendingUsernameNotice(second.id, 'tester', 'second notice', base + 1000);

  // The replay snapshots the outbox and then awaits each row in turn, so the
  // second row can be gone by the time it is reached: its own send, abandoned
  // at an earlier deadline, has settled and deleted it in the meantime.
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockReset();
  send.mockImplementation(async (_chat: string, text: string) => {
    if (text === 'first notice') deletePendingUsernameNoticesForMonitor(second.id);
    return undefined;
  });

  await replayPendingUsernameNotices();

  // Sending the snapshot regardless would have told the subscriber twice.
  expect(send.mock.calls.map((c: any[]) => c[1])).toEqual(['first notice']);
  expect(send).toHaveBeenCalledTimes(1);
  expect(pendingFor(first.id)).toBeUndefined();
  expect(pendingFor(second.id)).toBeUndefined();

  send.mockReset();
  removeMonitor('tester', '4000');
  removeMonitor('tester', '4001');
});

test('a row replaced while an earlier notice was being sent keeps the newer text for the next cycle', async () => {
  clearOutbox();
  const first = addMonitor('tester', '4100', 'firstrow', '4100111', null);
  const second = addMonitor('tester', '4101', 'secondrow', '4101111', null);
  const base = Date.now() - 60 * 60 * 1000;
  upsertPendingUsernameNotice(first.id, 'tester', 'first notice', base);
  upsertPendingUsernameNotice(second.id, 'tester', 'stale notice', base + 1000);

  // This time a fresh observation replaces the second row while the first is
  // being sent, so the snapshot's text describes a transition already
  // superseded and the row carries a new attempt token.
  const send = bot.telegram.sendMessage as jest.Mock<any>;
  send.mockReset();
  send.mockImplementation(async (_chat: string, text: string) => {
    if (text === 'first notice') {
      upsertPendingUsernameNotice(second.id, 'tester', 'newer notice', Date.now());
    }
    return undefined;
  });

  await replayPendingUsernameNotices();

  expect(send.mock.calls.map((c: any[]) => c[1])).toEqual(['first notice']);
  // The replacement is not re-read in this pass; it simply waits.
  expect(pendingFor(second.id)?.text).toBe('newer notice');
  expect(pendingFor(second.id)?.last_attempt_at).toBeNull();

  // The next cycle delivers it.
  send.mockReset();
  send.mockResolvedValue(undefined);
  await replayPendingUsernameNotices();
  expect(send.mock.calls.map((c: any[]) => c[1])).toEqual(['newer notice']);
  expect(pendingFor(second.id)).toBeUndefined();

  send.mockReset();
  removeMonitor('tester', '4100');
  removeMonitor('tester', '4101');
});
