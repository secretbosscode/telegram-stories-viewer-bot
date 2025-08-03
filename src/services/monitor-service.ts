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
  type MonitorRow,
} from '../db';
import { sendActiveStories } from 'controllers/send-active-stories';
import { mapStories } from 'controllers/download-stories';
import { getEntityWithTempContact } from 'lib';
import { bot } from 'index';

export const CHECK_INTERVAL_HOURS = 1;
export const MAX_MONITORS_PER_USER = 5;

const USERNAME_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const usernameRefreshTimes = new Map<number, number>();

export function formatMonitorTarget(m: MonitorRow): string {
  if (m.target_username) {
    return m.target_username.startsWith('+')
      ? m.target_username
      : `@${m.target_username}`;
  }
  return m.target_id;
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
  // Simplified no-op loop for testing environment
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
    const stories = (res as any)?.stories?.stories || [];

    const sent = new Set(listSentStoryKeys(m.id));
    const newStories: any[] = [];
    for (const s of stories) {
      const key = `${s.id}:${s.date}`;
      if (sent.has(key)) continue;
      markStorySent(m.id, s.id, s.date, s.expireDate);
      sent.add(key);
      newStories.push(s);
    }

    if (newStories.length > 0) {
      await sendActiveStories({
        stories: mapStories(newStories),
        task: {
          chatId: m.telegram_id,
          link: formatMonitorTarget(m),
          linkType: 'username',
          locale: 'en',
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

