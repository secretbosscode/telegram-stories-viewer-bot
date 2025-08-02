import { sendActiveStories } from 'controllers/send-active-stories';
import { mapStories } from 'controllers/download-stories';
import { Userbot } from 'config/userbot';
import { Api } from 'telegram';
import bigInt from 'big-integer';
import { isUserPremium } from './premium-service';
import {
  addMonitor,
  removeMonitor,
  countMonitors,
  listMonitors,
  listAllMonitors,
  updateMonitorChecked,
  updateMonitorPhoto,
  MonitorRow,
  getMonitor,
  findMonitorByTargetId,
  findMonitorByUsername,
  updateMonitorUsername,
  updateMonitorTarget,
  updateMonitorAccessHash,
  markStorySent,
  listSentStoryKeys,
  cleanupExpiredSentStories,
} from '../db';
import { UserInfo } from 'types';
import { BOT_ADMIN_ID } from 'config/env-config';
import { bot } from 'index';
import { getEntityWithTempContact } from 'lib';
import { t } from 'lib/i18n';

export const CHECK_INTERVAL_HOURS = 2;
export const MAX_MONITORS_PER_USER = 5;

const monitorTimers = new Map<number, NodeJS.Timeout>();
const usernameRefreshTimes = new Map<number, number>();
const USERNAME_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export function formatMonitorTarget(m: { target_username: string | null; target_id: string }): string {
  const username = m.target_username;
  if (username && !/^\+?\d+$/.test(username)) {
    return `@${username}`;
  }
  return username || m.target_id;
}

export async function addProfileMonitor(
  userId: string,
  username: string,
): Promise<boolean> {
  const entity = await getEntityWithTempContact(username);
  const targetId = String((entity as any).id);
  const accessHash = (entity as any).accessHash
    ? String((entity as any).accessHash)
    : null;

  let row =
    findMonitorByTargetId(userId, targetId) ||
    findMonitorByUsername(userId, username);

  if (row) {
    if (row.target_id !== targetId) {
      updateMonitorTarget(row.id, targetId);
      row.target_id = targetId;
    }
    if ((entity as any).username && row.target_username !== (entity as any).username) {
      updateMonitorUsername(row.id, (entity as any).username);
      row.target_username = (entity as any).username;
    }
    if (accessHash && row.target_access_hash !== accessHash) {
      updateMonitorAccessHash(row.id, accessHash);
      row.target_access_hash = accessHash;
    }

    const duplicates = listMonitors(userId).filter(
      (m) =>
        m.id !== row!.id &&
        (m.target_id === targetId || m.target_username === username),
    );
    for (const dup of duplicates) {
      if (monitorTimers.has(dup.id)) {
        clearTimeout(monitorTimers.get(dup.id)!);
        monitorTimers.delete(dup.id);
      }
      removeMonitor(userId, dup.target_id);
    }

    if (!monitorTimers.has(row.id)) {
      scheduleMonitor(row);
    }
    return false; // already monitoring
  }

  const latest = await fetchLatestProfilePhoto(entity);
  row = addMonitor(
    userId,
    targetId,
    (entity as any).username || username,
    accessHash,
    latest?.id || null,
  );
  scheduleMonitor(row);
  return true;
}

export async function removeProfileMonitor(
  userId: string,
  username: string,
): Promise<void> {
  let targetId: string | null = null;
  try {
    const entity = await getEntityWithTempContact(username);
    targetId = String((entity as any).id);
  } catch {
    // ignore resolve errors; we'll fall back to username match
  }

  const rows = listMonitors(userId).filter(
    (m) =>
      m.target_username === username ||
      (targetId !== null && m.target_id === targetId),
  );

  for (const row of rows) {
    if (monitorTimers.has(row.id)) {
      clearTimeout(monitorTimers.get(row.id)!);
      monitorTimers.delete(row.id);
    }
    removeMonitor(userId, row.target_id);
  }
}

export function userMonitorCount(userId: string): number {
  return countMonitors(userId);
}

export function listUserMonitors(userId: string): MonitorRow[] {
  return listMonitors(userId);
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
          updateMonitorUsername(m.id, username);
          m.target_username = username;
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
      updateMonitorUsername(m.id, username);
      m.target_username = username;
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

export function startMonitorLoop(): void {
  const all = listAllMonitors();
  for (const m of all) {
    scheduleMonitor(m);
  }
}

async function fetchActiveStories(entityOrUsername: any) {
  const client = await Userbot.getInstance();
  const entity =
    typeof entityOrUsername === 'string'
      ? await client.getEntity(entityOrUsername)
      : entityOrUsername;
  const activeResult = await client.invoke(
    new Api.stories.GetPeerStories({ peer: entity }),
  );
  return mapStories(activeResult.stories?.stories || []);
}

async function fetchLatestProfilePhoto(
  entityOrUsername: any
): Promise<{ photo: Api.Photo; id: string } | null> {
  const client = await Userbot.getInstance();
  const entity =
    typeof entityOrUsername === 'string'
      ? await getEntityWithTempContact(entityOrUsername)
      : entityOrUsername;
  const result = (await client.invoke(
    new Api.photos.GetUserPhotos({ userId: entity, limit: 1 })
  )) as Api.photos.Photos;
  const photo = 'photos' in result ? result.photos[0] : null;
  if (photo instanceof Api.Photo) {
    return { photo, id: String(photo.id) };
  }
  return null;
}

function scheduleMonitor(m: MonitorRow) {
  const last = m.last_checked ? m.last_checked * 1000 : 0;
  const next = last + CHECK_INTERVAL_HOURS * 3600 * 1000;
  const delay = Math.max(next - Date.now(), 0);
  const timer = setTimeout(() => checkSingleMonitor(m.id), delay);
  monitorTimers.set(m.id, timer);
}

export async function checkSingleMonitor(id: number) {
  const m = getMonitor(id);
  if (!m) return; // might have been removed
  try {
    const client = await Userbot.getInstance();
    let entity: any;
    try {
      entity = await getEntityWithTempContact(m.target_id);
    } catch {
      try {
        entity = await getEntityWithTempContact(
          m.target_username || m.target_id,
        );
      } catch {
        if (m.target_access_hash) {
          try {
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
            entity = Array.isArray(res) ? res[0] : null;
          } catch {}
        }
      }
    }
    if (!entity) throw new Error('Cannot find any entity');
    const oldUsername = m.target_username;
    const oldDisplay = formatMonitorTarget(m);
    const username = (entity as any).username || null;
    const idStr = String((entity as any).id);
    const accessHash = (entity as any).accessHash
      ? String((entity as any).accessHash)
      : null;
    if (username && username !== m.target_username) {
      updateMonitorUsername(m.id, username);
      m.target_username = username;
    }
    if (idStr !== m.target_id) {
      const existing = findMonitorByTargetId(m.telegram_id, idStr);
      if (existing && existing.id !== m.id) {
        if (monitorTimers.has(existing.id)) {
          clearTimeout(monitorTimers.get(existing.id)!);
          monitorTimers.delete(existing.id);
        }
        removeMonitor(m.telegram_id, existing.target_id);
      }
      updateMonitorTarget(m.id, idStr);
      m.target_id = idStr;
    }
    if (accessHash && accessHash !== m.target_access_hash) {
      updateMonitorAccessHash(m.id, accessHash);
      m.target_access_hash = accessHash;
    }

    if (username && username !== oldUsername) {
      await bot.telegram.sendMessage(
        m.telegram_id,
        t('', 'monitor.usernameChanged', {
          old: oldDisplay,
          user: formatMonitorTarget(m),
        }),
      );
    }

    const task: UserInfo = {
      chatId: m.telegram_id,
      link: m.target_username || m.target_id,
      linkType: 'username',
      locale: '',
      initTime: Date.now(),
      isPremium:
        isUserPremium(m.telegram_id) || m.telegram_id === BOT_ADMIN_ID.toString(),
    };

    const mapped = await fetchActiveStories(entity);
    cleanupExpiredSentStories();
    const sentKeys = new Set(listSentStoryKeys(m.id));
    const newStories = mapped.filter((s) => {
      const key = `${s.id}:${Math.floor(s.date.getTime() / 1000)}`;
      return !sentKeys.has(key);
    });
    if (newStories.length) {
      await sendActiveStories({ stories: newStories, task });
      for (const s of newStories) {
        const expiry = Math.floor(s.date.getTime() / 1000) + 24 * 3600;
        const ts = Math.floor(s.date.getTime() / 1000);
        markStorySent(m.id, s.id, ts, expiry);
      }
    }

    const latest = await fetchLatestProfilePhoto(entity);
    const latestId = latest?.id || null;
    if (latestId !== (m.last_photo_id || null)) {
      if (latest) {
        const buffer = (await client.downloadMedia(latest.photo as any)) as Buffer;
        await bot.telegram.sendPhoto(m.telegram_id, { source: buffer });
        await bot.telegram.sendMessage(
          m.telegram_id,
          t('', 'monitor.photoChanged', {
            user: formatMonitorTarget(m),
          })
        );
      } else if (m.last_photo_id) {
        await bot.telegram.sendMessage(
          m.telegram_id,
          t('', 'monitor.photoRemoved', {
            user: formatMonitorTarget(m),
          })
        );
      }
      updateMonitorPhoto(m.id, latestId);
    }
    updateMonitorChecked(m.id);
    scheduleMonitor({ ...m, last_checked: Math.floor(Date.now() / 1000) });
  } catch (err: any) {
    console.error(`[Monitor] Error checking ${formatMonitorTarget(m)}:`, err);
    const msg = err?.errorMessage || err?.message || '';
    const display = formatMonitorTarget(m);
    if (/ACCOUNT_DELETED|USER_DEACTIVATED/i.test(msg)) {
      if (monitorTimers.has(m.id)) {
        clearTimeout(monitorTimers.get(m.id)!);
        monitorTimers.delete(m.id);
      }
      removeMonitor(m.telegram_id, m.target_id);
      await bot.telegram.sendMessage(
        m.telegram_id,
        t('', 'monitor.deleted', { user: display })
      );
    } else if (/USERNAME_INVALID|No user has|Cannot find any entity/i.test(msg)) {
      if (monitorTimers.has(m.id)) {
        clearTimeout(monitorTimers.get(m.id)!);
        monitorTimers.delete(m.id);
      }
      removeMonitor(m.telegram_id, m.target_id);
      await bot.telegram.sendMessage(
        m.telegram_id,
        t('', 'monitor.stopped', { user: display })
      );
    } else {
      scheduleMonitor(m);
    }
  }
}
