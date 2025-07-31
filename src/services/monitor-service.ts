import { sendActiveStories } from 'controllers/send-active-stories';
import { mapStories } from 'controllers/download-stories';
import { Userbot } from 'config/userbot';
import { Api } from 'telegram';
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
  findMonitor,
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

export async function addProfileMonitor(userId: string, username: string): Promise<boolean> {
  let row = findMonitor(userId, username);
  if (row) {
    if (!monitorTimers.has(row.id)) {
      scheduleMonitor(row);
    }
    return false; // already monitoring
  }
  const latest = await fetchLatestProfilePhoto(username);
  row = addMonitor(userId, username, latest?.id || null);
  scheduleMonitor(row);
  return true;
}

export function removeProfileMonitor(userId: string, username: string): void {
  const row = findMonitor(userId, username);
  if (row && monitorTimers.has(row.id)) {
    clearTimeout(monitorTimers.get(row.id)!);
    monitorTimers.delete(row.id);
  }
  removeMonitor(userId, username);
}

export function userMonitorCount(userId: string): number {
  return countMonitors(userId);
}

export function listUserMonitors(userId: string): MonitorRow[] {
  return listMonitors(userId);
}

export function startMonitorLoop(): void {
  const all = listAllMonitors();
  for (const m of all) {
    scheduleMonitor(m);
  }
}

async function fetchActiveStories(username: string) {
  const client = await Userbot.getInstance();
  const entity = await client.getEntity(username);
  const activeResult = await client.invoke(
    new Api.stories.GetPeerStories({ peer: entity }),
  );
  return mapStories(activeResult.stories?.stories || []);
}

async function fetchLatestProfilePhoto(username: string): Promise<{ photo: Api.Photo; id: string } | null> {
  const client = await Userbot.getInstance();
  const entity = await getEntityWithTempContact(username);
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

async function checkSingleMonitor(id: number) {
  const m = getMonitor(id);
  if (!m) return; // might have been removed
  const task: UserInfo = {
    chatId: m.telegram_id,
    link: m.target_username,
    linkType: 'username',
    locale: '',
    initTime: Date.now(),
    isPremium:
      isUserPremium(m.telegram_id) || m.telegram_id === BOT_ADMIN_ID.toString(),
  };

  const mapped = await fetchActiveStories(task.link);
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

  const latest = await fetchLatestProfilePhoto(task.link);
  const latestId = latest?.id || null;
  if (latestId !== (m.last_photo_id || null)) {
    if (latest) {
      const client = await Userbot.getInstance();
      const buffer = (await client.downloadMedia(latest.photo as any)) as Buffer;
      await bot.telegram.sendPhoto(m.telegram_id, { source: buffer });
      await bot.telegram.sendMessage(
        m.telegram_id,
        t('', 'monitor.photoChanged', { user: `@${m.target_username}` })
      );
    } else if (m.last_photo_id) {
      await bot.telegram.sendMessage(
        m.telegram_id,
        t('', 'monitor.photoRemoved', { user: `@${m.target_username}` })
      );
    }
    updateMonitorPhoto(m.id, latestId);
  }
  updateMonitorChecked(m.id);
  scheduleMonitor({ ...m, last_checked: Math.floor(Date.now() / 1000) });
}
