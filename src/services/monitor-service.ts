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
  getDueMonitors,
  updateMonitorChecked,
  MonitorRow,
} from '../db';
import { UserInfo } from 'types';
import { BOT_ADMIN_ID } from 'config/env-config';

export const CHECK_INTERVAL_HOURS = 6;
export const MAX_MONITORS_PER_USER = 5;

export function addProfileMonitor(userId: string, username: string): void {
  addMonitor(userId, username);
}

export function removeProfileMonitor(userId: string, username: string): void {
  removeMonitor(userId, username);
}

export function userMonitorCount(userId: string): number {
  return countMonitors(userId);
}

export function listUserMonitors(userId: string): MonitorRow[] {
  return listMonitors(userId);
}

export function startMonitorLoop(): void {
  setInterval(checkMonitors, CHECK_INTERVAL_HOURS * 3600 * 1000);
}

async function fetchActiveStories(username: string) {
  const client = await Userbot.getInstance();
  const entity = await client.getEntity(username);
  const activeResult = await client.invoke(
    new Api.stories.GetPeerStories({ peer: entity })
  );
  return mapStories(activeResult.stories?.stories || []);
}

export async function checkMonitors(): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - CHECK_INTERVAL_HOURS * 3600;
  const monitors = getDueMonitors(cutoff);
  for (const m of monitors) {
    const task: UserInfo = {
      chatId: m.telegram_id,
      link: m.target_username,
      linkType: 'username',
      locale: '',
      initTime: Date.now(),
      isPremium: isUserPremium(m.telegram_id) || m.telegram_id === BOT_ADMIN_ID.toString(),
    };
    const mapped = await fetchActiveStories(task.link);
    if (mapped.length) {
      await sendActiveStories({ stories: mapped, task });
    }
    updateMonitorChecked(m.id);
  }
}

