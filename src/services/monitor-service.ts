import { Api } from 'telegram';
import bigInt from 'big-integer';
import { Userbot } from '../config/userbot';
import {
  addMonitor,
  removeMonitor,
  findMonitorByUsername,
  countMonitors,
  listMonitors,
  getMonitor,
  updateMonitorUsername,
  updateMonitorAccessHash,
  updateMonitorTarget,
  updateMonitorChecked,
  updateMonitorPhoto,
  listSentStoryKeys,
  markStorySent,
  listAllMonitors,
  type MonitorRow,
} from '../db';
import { sendActiveStories } from 'controllers/send-active-stories';
import { sendPinnedStories } from 'controllers/send-pinned-stories';
import { sendArchivedStories } from 'controllers/send-archived-stories';
import { sendGlobalStories } from 'controllers/send-global-stories';
import { mapStories } from 'controllers/download-stories';
import { getEntityWithTempContact } from 'lib';
import { bot } from 'index';
import { t } from '../lib/i18n';
import { findUserById } from '../repositories/user-repository';

export const CHECK_INTERVAL_HOURS = 1;
export const MAX_MONITORS_PER_USER = 5;

const USERNAME_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const usernameRefreshTimes = new Map<number, number>();

// Track when the next monitor cycle is scheduled
let nextMonitorCheckAt: number | null = null;
// Store the timeout handle for the monitor loop
let monitorTimer: NodeJS.Timeout | null = null;

function scheduleNextMonitorCheck() {
  if (monitorCheckTimer) {
    clearTimeout(monitorCheckTimer);
  }
  const intervalMs = CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
  nextMonitorCheckAt = Date.now() + intervalMs;
  monitorTimer = setTimeout(async () => {
    try {
      await forceCheckMonitors();
    } catch (err) {
      console.error('[Monitor] Scheduled check error:', err);
    }
  }, intervalMs);
}

export function getNextMonitorCheck(): number | null {
  return nextMonitorCheckAt;
}

export function formatMonitorTarget(m: MonitorRow): string {
  if (m.target_username) {
    return m.target_username.startsWith('+')
      ? m.target_username
      : `@${m.target_username}`;
  }
  return m.target_id;
}

async function notifyUsernameChange(
  m: MonitorRow,
  newUsername: string,
): Promise<void> {
  const oldUsername = m.target_username;
  updateMonitorUsername(m.id, newUsername);
  m.target_username = newUsername;
  if (!oldUsername) return;
  const lang = findUserById(m.telegram_id)?.language;
  const format = (u: string) => (u.startsWith('+') ? u : `@${u}`);
  await bot.telegram.sendMessage(
    m.telegram_id,
    t(lang, 'monitor.usernameChanged', {
      old: format(oldUsername),
      user: format(newUsername),
    }),
  );
}

export async function addProfileMonitor(
  telegramId: string,
  username: string,
): Promise<MonitorRow | null> {
  const existing = findMonitorByUsername(telegramId, username);
  if (existing) return null;

  const entity = await getEntityWithTempContact(username);
  const targetId = String((entity as any).id);
  const accessHash = (entity as any).accessHash
    ? String((entity as any).accessHash)
    : null;
  const targetUsername = (entity as any).username || username;
  return addMonitor(telegramId, targetId, targetUsername, accessHash);
}

export async function removeProfileMonitor(
  telegramId: string,
  username: string,
): Promise<void> {
  const existing = findMonitorByUsername(telegramId, username);
  if (existing) {
    removeMonitor(telegramId, existing.target_id);
  }
}

export function userMonitorCount(telegramId: string): number {
  return countMonitors(telegramId);
}

export function listUserMonitors(telegramId: string): MonitorRow[] {
  return listMonitors(telegramId);
}

export function startMonitorLoop(): void {
  stopMonitorLoop();
  scheduleNextMonitorCheck();
}

export function stopMonitorLoop(): void {
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
    nextMonitorCheckAt = null;
  }
}

export async function forceCheckMonitors(): Promise<number> {
  if (monitorCheckTimer) {
    clearTimeout(monitorCheckTimer);
    monitorCheckTimer = null;
  }
  const monitors = listAllMonitors();
  try {
    for (const m of monitors) {
      await checkSingleMonitor(m.id);
    }
  } finally {
    scheduleNextMonitorCheck();
  }
  return monitors.length;
}

export async function refreshMonitorUsername(m: MonitorRow): Promise<void> {
  const last = usernameRefreshTimes.get(m.id) || 0;
  if (Date.now() - last < USERNAME_REFRESH_INTERVAL_MS) return;
  usernameRefreshTimes.set(m.id, Date.now());

  try {
    if (m.target_access_hash) {
      const client = await Userbot.getInstance();
      const res = await client.invoke(
        new Api.users.GetUsers({
          id: [
            new Api.InputUser({
              userId: bigInt(m.target_id),
              accessHash: bigInt(m.target_access_hash),
            }),
          ],
        }),
      );
      const user = Array.isArray(res) ? res[0] : res;
      if (user) {
        const username = (user as any).username || null;
        const accessHash = (user as any).accessHash
          ? String((user as any).accessHash)
          : null;
        if (username && username !== m.target_username) {
          await notifyUsernameChange(m, username);
        }
        if (accessHash && accessHash !== m.target_access_hash) {
          updateMonitorAccessHash(m.id, accessHash);
          m.target_access_hash = accessHash;
        }
      }
      return;
    }

    const entity = await getEntityWithTempContact(
      m.target_username || m.target_id,
    );
    const username = (entity as any).username || null;
    const idStr = String((entity as any).id);
    const accessHash = (entity as any).accessHash
      ? String((entity as any).accessHash)
      : null;

    if (username && username !== m.target_username) {
      await notifyUsernameChange(m, username);
    }
    if (idStr !== m.target_id) {
      updateMonitorTarget(m.id, idStr);
      m.target_id = idStr;
    }
    if (accessHash && accessHash !== m.target_access_hash) {
      updateMonitorAccessHash(m.id, accessHash);
      m.target_access_hash = accessHash;
    }
  } catch (err) {
    console.error(
      `[Monitor] Error refreshing username for ${formatMonitorTarget(m)}:`,
      err,
    );
  }
}

export async function checkSingleMonitor(id: number): Promise<void> {
  const m = getMonitor(id);
  if (!m) return;
  await refreshMonitorUsername(m);

  try {
        const client = await Userbot.getInstance();
    const peer = new Api.InputUser({
      userId: bigInt(m.target_id),
      accessHash: m.target_access_hash
        ? bigInt(m.target_access_hash)
        : bigInt.zero,
    });

    const res = await client.invoke(
      new Api.stories.GetPeerStories({ peer }),
    );
    const pinnedRes = await client.invoke(
      new Api.stories.GetPinnedStories({ peer }),
    ).catch(() => ({ stories: [] } as any));
    const archivedRes = await client.invoke(
      new Api.stories.GetStoriesArchive({ peer, offsetId: 0 }),
    ).catch(() => ({ stories: [] } as any));
    const globalRes = await client.invoke(
      new Api.stories.GetAllStories({}),
    ).catch(() => ({ stories: [] } as any));

    const activeStories = (res as any)?.stories?.stories || [];
    const pinnedStories = (pinnedRes as any)?.stories || [];
    const archivedStories = (archivedRes as any)?.stories || [];
    const globalStories = (globalRes as any)?.stories || [];

    const activeSent = new Set(listSentStoryKeys(m.id, 'active'));
    const pinnedSent = new Set(listSentStoryKeys(m.id, 'pinned'));
    const archivedSent = new Set(listSentStoryKeys(m.id, 'archived'));
    const globalSent = new Set(listSentStoryKeys(m.id, 'global'));

    const newActive: any[] = [];
    for (const s of activeStories) {
      const key = `${s.id}:${s.date}`;
      if (activeSent.has(key)) continue;
      markStorySent(m.id, s.id, s.date, s.expireDate, 'active');
      activeSent.add(key);
      newActive.push(s);
    }

    const newPinned: any[] = [];
    for (const s of pinnedStories) {
      const key = `${s.id}:${s.date}`;
      if (pinnedSent.has(key)) continue;
      markStorySent(m.id, s.id, s.date, s.expireDate, 'pinned');
      pinnedSent.add(key);
      newPinned.push(s);
    }

    const newArchived: any[] = [];
    for (const s of archivedStories) {
      const key = `${s.id}:${s.date}`;
      if (archivedSent.has(key)) continue;
      markStorySent(m.id, s.id, s.date, s.expireDate, 'archived');
      archivedSent.add(key);
      newArchived.push(s);
    }

    const newGlobal: any[] = [];
    for (const s of globalStories) {
      const key = `${s.id}:${s.date}`;
      if (globalSent.has(key)) continue;
      markStorySent(m.id, s.id, s.date, s.expireDate, 'global');
      globalSent.add(key);
      newGlobal.push(s);
    }

    const lang = findUserById(m.telegram_id)?.language || 'en';

    if (newActive.length > 0) {
      await sendActiveStories({
        stories: mapStories(newActive),
        task: {
          chatId: m.telegram_id,
          link: formatMonitorTarget(m),
          linkType: 'username',
          locale: lang,
          initTime: Date.now(),
        } as any,
      });
    }
    if (newPinned.length > 0) {
      await sendPinnedStories({
        stories: mapStories(newPinned),
        task: {
          chatId: m.telegram_id,
          link: formatMonitorTarget(m),
          linkType: 'username',
          locale: lang,
          initTime: Date.now(),
        } as any,
      });
    }
    if (newArchived.length > 0) {
      await sendArchivedStories({
        stories: mapStories(newArchived),
        task: {
          chatId: m.telegram_id,
          link: formatMonitorTarget(m),
          linkType: 'username',
          locale: lang,
          initTime: Date.now(),
        } as any,
      });
    }
    if (newGlobal.length > 0) {
      await sendGlobalStories({
        stories: mapStories(newGlobal),
        task: {
          chatId: m.telegram_id,
          link: formatMonitorTarget(m),
          linkType: 'username',
          locale: lang,
          initTime: Date.now(),
        } as any,
      });
    }

    try {
      const photoRes = await client.invoke(
        new Api.photos.GetUserPhotos({ userId: peer, limit: 1 }),
      );
      const photos = (photoRes as any)?.photos || [];
      const latest = photos[0];
      const latestId = latest ? String(latest.id) : null;
      if (latestId !== m.last_photo_id) {
        if (latest && latestId) {
          try {
            const buffer = (await client.downloadMedia(latest as any)) as Buffer;
            const isVideo =
              'videoSizes' in latest &&
              Array.isArray((latest as any).videoSizes) &&
              (latest as any).videoSizes.length > 0;
            const caption = `New profile ${isVideo ? 'video' : 'photo'} from ${formatMonitorTarget(m)}`;
            if (isVideo) {
              await bot.telegram.sendVideo(
                m.telegram_id,
                { source: buffer },
                { caption },
              );
            } else {
              await bot.telegram.sendPhoto(
                m.telegram_id,
                { source: buffer },
                { caption },
              );
            }
          } catch (err) {
            console.error(
              `[Monitor] Error sending profile media for ${formatMonitorTarget(m)}:`,
              err,
            );
          }
        }
        updateMonitorPhoto(m.id, latestId);
      }
    } catch (err) {
      console.error(
        `[Monitor] Error checking profile photo for ${formatMonitorTarget(m)}:`,
        err,
      );
    }
  } catch (err) {
    console.error(
      `[Monitor] Error checking ${formatMonitorTarget(m)}:`,
      err,
    );
  }

  updateMonitorChecked(id);
}

