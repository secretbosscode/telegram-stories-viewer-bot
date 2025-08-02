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
  type MonitorRow,
} from '../db';
import { getEntityWithTempContact } from 'lib';

export const CHECK_INTERVAL_HOURS = 1;
export const MAX_MONITORS_PER_USER = 5;

const USERNAME_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const usernameRefreshTimes = new Map<number, number>();

export function formatMonitorTarget(m: MonitorRow): string {
  return m.target_username ? `@${m.target_username}` : m.target_id;
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
  updateMonitorChecked(id);
}

