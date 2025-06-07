import { getAllStoriesFx } from 'controllers/get-stories';
import { sendActiveStories } from 'controllers/send-active-stories';
import { mapStories } from 'controllers/download-stories';
import { isUserPremium } from './premium-service';
import { addMonitor, countMonitors, listMonitors, getDueMonitors, updateMonitorChecked, MonitorRow } from '../db';
import { UserInfo } from 'types';
import { BOT_ADMIN_ID } from 'config/env-config';

const CHECK_INTERVAL_HOURS = 6;

export function addProfileMonitor(userId: string, username: string): void {
  addMonitor(userId, username);
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
    const data = await getAllStoriesFx(task);
    if (typeof data !== 'string') {
      const mapped = mapStories(data.activeStories || []);
      if (mapped.length) {
        await sendActiveStories({ stories: mapped, task });
      }
    }
    updateMonitorChecked(m.id);
  }
}

