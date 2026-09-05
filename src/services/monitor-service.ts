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
import { mapStories } from 'controllers/download-stories';
import { getEntityWithTempContact } from 'lib';
import { bot } from 'index';
import { t } from '../lib/i18n';
import { findUserById } from '../repositories/user-repository';
import { isUserPremium } from 'services/premium-service';
import { BOT_ADMIN_ID } from 'config/env-config';
import { ensureStealthMode } from 'services/stealth-mode';
import {
  authorizeStarsMonitorRemoval,
  clearStarsMonitorRemovalAuthorization,
  getStarsMonitoringEntitlement,
  reconcileStarsMonitorLimit,
} from 'services/stars-mode-safety';

export const CHECK_INTERVAL_HOURS = 1;
export const MAX_MONITORS_PER_USER = 5;

const USERNAME_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const usernameRefreshTimes = new Map<number, number>();
// Tracks a single empty GetUserPhotos result per monitor, so a transient or
// privacy-driven absence does not immediately raise "photo removed".
const photoAbsenceStreak = new Map<number, boolean>();

// Spacing between targets. The cycle has a full hour of budget and needs only
// seconds of it, so pacing costs nothing and keeps the account well clear of
// the per-method flood limits that previously fired every run.
const MONITOR_TARGET_DELAY_MS = 1_500;
const MONITOR_TARGET_JITTER_MS = 750;

// Profile photos change far less often than stories. Checking them on every
// target every hour was the single largest source of flood waits, so stagger
// them across cycles instead.
const PHOTO_CHECK_EVERY_N_CYCLES = 3;
let monitorCycleCount = 0;

let nextMonitorCheckAt: number | null = null;
let monitorTimer: NodeJS.Timeout | null = null;
// Set by stopMonitorLoop() so an in-flight cycle does not reschedule itself.
let monitorStopped = false;
// Guards against a scheduled cycle overlapping a manual /forcemonitor run.
let monitorRunning = false;

function scheduleNextMonitorCheck(startedAt?: number) {
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
  }
  if (monitorStopped) {
    nextMonitorCheckAt = null;
    return;
  }
  const intervalMs = CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
  // Anchor the next run to when this cycle *started*, not when it finished.
  // Scheduling from completion made the interval drift by the cycle duration
  // every hour (05:34 -> 06:35 -> 07:36 in production logs).
  const dueAt = (startedAt ?? Date.now()) + intervalMs;
  const delayMs = Math.max(0, dueAt - Date.now());
  nextMonitorCheckAt = Date.now() + delayMs;
  monitorTimer = setTimeout(async () => {
    try {
      await forceCheckMonitors();
    } catch (error) {
      console.error('[Monitor] Scheduled check error:', error);
    }
  }, delayMs);
  monitorTimer.unref?.();
}

const monitorSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export function getNextMonitorCheck(): number | null {
  return nextMonitorCheckAt;
}

export function formatMonitorTarget(monitor: MonitorRow): string {
  if (monitor.target_username) {
    return monitor.target_username.startsWith('+')
      ? monitor.target_username
      : `@${monitor.target_username}`;
  }
  return monitor.target_id;
}

async function notifyUsernameChange(
  monitor: MonitorRow,
  newUsername: string,
): Promise<void> {
  const oldUsername = monitor.target_username;
  updateMonitorUsername(monitor.id, newUsername);
  monitor.target_username = newUsername;
  if (!oldUsername) return;
  const language = findUserById(monitor.telegram_id)?.language;
  const format = (username: string) => (username.startsWith('+') ? username : `@${username}`);
  await bot.telegram.sendMessage(
    monitor.telegram_id,
    t(language, 'monitor.usernameChanged', {
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
  target: string,
): Promise<void> {
  // Private or username-less monitors are displayed and removed by target ID.
  // Resolve both forms here so every caller shares the same authorization and
  // deletion path instead of reporting success for an unchanged monitor row.
  const existing =
    findMonitorByUsername(telegramId, target) ||
    listMonitors(telegramId).find((monitor) => monitor.target_id === target);
  if (!existing) return;

  const hasStarsEntitlement = Boolean(getStarsMonitoringEntitlement(telegramId));
  if (hasStarsEntitlement) {
    authorizeStarsMonitorRemoval(telegramId, existing.target_id);
  }
  try {
    removeMonitor(telegramId, existing.target_id);
    // Drop the per-monitor bookkeeping so these maps cannot grow for the
    // lifetime of the process.
    usernameRefreshTimes.delete(existing.id);
    photoAbsenceStreak.delete(existing.id);
  } finally {
    if (hasStarsEntitlement) {
      clearStarsMonitorRemovalAuthorization(telegramId, existing.target_id);
    }
  }
}

export function userMonitorCount(telegramId: string): number {
  return countMonitors(telegramId);
}

export function listUserMonitors(telegramId: string): MonitorRow[] {
  return listMonitors(telegramId);
}

export function startMonitorLoop(runImmediately = true): void {
  stopMonitorLoop();
  monitorStopped = false;
  if (runImmediately) {
    // Catch the rejection: an unhandled one here at startup would be fatal.
    void forceCheckMonitors().catch((error) =>
      console.error('[Monitor] Initial check error:', error),
    );
  } else {
    scheduleNextMonitorCheck();
  }
}

export function stopMonitorLoop(): void {
  // The flag matters as much as the timer: a cycle already in flight
  // reschedules itself in its finally block, which previously made
  // /stopmonitor appear to work while the loop kept running.
  monitorStopped = true;
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
  }
  nextMonitorCheckAt = null;
}

export async function forceCheckMonitors(): Promise<number> {
  if (monitorRunning) {
    console.warn('[Monitor] A check cycle is already running; skipping this request.');
    return 0;
  }
  monitorRunning = true;
  const startedAt = Date.now();
  monitorCycleCount += 1;
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
  }
  let monitors = listAllMonitors();
  const premiumCache = new Map<string, boolean>();
  const reconciledUsers = new Set<string>();
  try {
    for (const monitor of monitors) {
      let premium = premiumCache.get(monitor.telegram_id);
      if (premium === undefined) {
        premium = isUserPremium(monitor.telegram_id);
        premiumCache.set(monitor.telegram_id, premium);
      }
      const starsEntitlement = getStarsMonitoringEntitlement(monitor.telegram_id);
      if (
        !premium &&
        Number(monitor.telegram_id) !== BOT_ADMIN_ID &&
        starsEntitlement &&
        !reconciledUsers.has(monitor.telegram_id)
      ) {
        reconcileStarsMonitorLimit(monitor.telegram_id);
        reconciledUsers.add(monitor.telegram_id);
      }
    }

    monitors = listAllMonitors();
    let checked = 0;
    for (const monitor of monitors) {
      if (monitorStopped) {
        console.log('[Monitor] Loop stopped; abandoning the rest of this cycle.');
        break;
      }
      try {
        let premium = premiumCache.get(monitor.telegram_id);
        if (premium === undefined) {
          premium = isUserPremium(monitor.telegram_id);
          premiumCache.set(monitor.telegram_id, premium);
        }
        const starsEntitlement = getStarsMonitoringEntitlement(monitor.telegram_id);
        if (!premium && Number(monitor.telegram_id) !== BOT_ADMIN_ID && !starsEntitlement) {
          removeMonitor(monitor.telegram_id, monitor.target_id);
          continue;
        }
        // Space out targets. Without this the loop issued every request
        // back-to-back and reliably tripped Telegram's per-method flood limits.
        if (checked > 0) {
          await monitorSleep(
            MONITOR_TARGET_DELAY_MS + Math.floor(Math.random() * MONITOR_TARGET_JITTER_MS),
          );
        }
        checked += 1;
        // Stagger the profile-photo check by monitor id so the extra call is
        // spread across cycles rather than fired for every target every hour.
        const checkPhoto =
          (monitorCycleCount + monitor.id) % PHOTO_CHECK_EVERY_N_CYCLES === 0;
        await checkSingleMonitor(monitor.id, checkPhoto);
      } catch (error) {
        // One bad row must never abort the cycle for everyone else.
        console.error(
          `[Monitor] Unhandled error while checking monitor ${monitor.id}:`,
          error,
        );
      }
    }
  } finally {
    monitorRunning = false;
    scheduleNextMonitorCheck(startedAt);
  }
  return monitors.length;
}

export async function refreshMonitorUsername(monitor: MonitorRow): Promise<void> {
  const last = usernameRefreshTimes.get(monitor.id) || 0;
  if (Date.now() - last < USERNAME_REFRESH_INTERVAL_MS) return;
  usernameRefreshTimes.set(monitor.id, Date.now());

  try {
    if (monitor.target_access_hash) {
      const client = await Userbot.getInstance();
      const response = await client.invoke(
        new Api.users.GetUsers({
          id: [
            new Api.InputUser({
              userId: bigInt(monitor.target_id),
              accessHash: bigInt(monitor.target_access_hash),
            }),
          ],
        }),
      );
      const user = Array.isArray(response) ? response[0] : response;
      if (user) {
        const username = (user as any).username || null;
        const accessHash = (user as any).accessHash
          ? String((user as any).accessHash)
          : null;
        if (username && username !== monitor.target_username) {
          await notifyUsernameChange(monitor, username);
        }
        if (accessHash && accessHash !== monitor.target_access_hash) {
          updateMonitorAccessHash(monitor.id, accessHash);
          monitor.target_access_hash = accessHash;
        }
      }
      return;
    }

    const entity = await getEntityWithTempContact(
      monitor.target_username || monitor.target_id,
    );
    const username = (entity as any).username || null;
    const idString = String((entity as any).id);
    const accessHash = (entity as any).accessHash
      ? String((entity as any).accessHash)
      : null;

    if (username && username !== monitor.target_username) {
      await notifyUsernameChange(monitor, username);
    }
    if (idString !== monitor.target_id) {
      updateMonitorTarget(monitor.id, idString);
      monitor.target_id = idString;
    }
    if (accessHash && accessHash !== monitor.target_access_hash) {
      updateMonitorAccessHash(monitor.id, accessHash);
      monitor.target_access_hash = accessHash;
    }
  } catch (error) {
    console.error(
      `[Monitor] Error refreshing username for ${formatMonitorTarget(monitor)}:`,
      error,
    );
  }
}

function storyKey(story: any): string {
  return `${story.id}:${story.date}`;
}

function recordDeliveredStories(
  monitorId: number,
  stories: any[],
  deliveredIds: Set<number>,
  type: 'active' | 'pinned',
): void {
  for (const story of stories) {
    if (!deliveredIds.has(Number(story.id))) continue;
    markStorySent(
      monitorId,
      story.id,
      story.date,
      type === 'active' ? story.expireDate : story.expireDate ?? null,
      type,
    );
  }
}

/**
 * Checks one monitored target for new stories, and optionally for a changed
 * profile photo.
 *
 * @param checkPhoto Whether to issue the extra photos.GetUserPhotos call. The
 *   hourly loop staggers this across cycles (see PHOTO_CHECK_EVERY_N_CYCLES)
 *   because doing it for every target every hour was the largest single source
 *   of flood waits. Direct callers get the full check by default.
 */
export async function checkSingleMonitor(
  id: number,
  checkPhoto = true,
): Promise<void> {
  const monitor = getMonitor(id);
  if (!monitor) return;
  await refreshMonitorUsername(monitor);

  try {
    const targetLabel = formatMonitorTarget(monitor);
    console.log(
      `[Monitor] Checking ${targetLabel} for subscriber ${monitor.telegram_id}.`,
    );
    const client = await Userbot.getInstance();
    await ensureStealthMode();
    const peer = new Api.InputUser({
      userId: bigInt(monitor.target_id),
      accessHash: monitor.target_access_hash
        ? bigInt(monitor.target_access_hash)
        : bigInt.zero,
    });

    // Settled rather than all: a failure on the pinned side (the more
    // flood-prone of the two) previously discarded active stories that had
    // already been fetched successfully, losing an hour of coverage.
    const [responseResult, pinnedResult] = await Promise.allSettled([
      client.invoke(new Api.stories.GetPeerStories({ peer })),
      client.invoke(new Api.stories.GetPinnedStories({ peer })),
    ]);

    if (responseResult.status === 'rejected' && pinnedResult.status === 'rejected') {
      throw responseResult.reason;
    }
    if (responseResult.status === 'rejected') {
      console.error(
        `[Monitor] Failed to fetch active stories for ${targetLabel}:`,
        responseResult.reason,
      );
    }
    if (pinnedResult.status === 'rejected') {
      console.error(
        `[Monitor] Failed to fetch pinned stories for ${targetLabel}:`,
        pinnedResult.reason,
      );
    }

    const response = responseResult.status === 'fulfilled' ? responseResult.value : null;
    const pinnedResponse = pinnedResult.status === 'fulfilled' ? pinnedResult.value : null;

    const activeStories = (response as any)?.stories?.stories || [];
    const pinnedStories = ((pinnedResponse as any)?.stories || []) as any[];

    const persistedActiveKeys = new Set(listSentStoryKeys(monitor.id, 'active'));
    const persistedPinnedKeys = new Set(listSentStoryKeys(monitor.id, 'pinned'));

    const newActive = activeStories.filter(
      (story: any) => !persistedActiveKeys.has(storyKey(story)),
    );
    const activeCandidateKeys = new Set(newActive.map(storyKey));
    const newPinned = pinnedStories.filter((story: any) => {
      if (typeof story?.id !== 'number' || typeof story?.date !== 'number') return false;
      const key = storyKey(story);
      return (
        !persistedPinnedKeys.has(key) &&
        !persistedActiveKeys.has(key) &&
        !activeCandidateKeys.has(key)
      );
    });

    const language = findUserById(monitor.telegram_id)?.language || 'en';

    if (newActive.length > 0) {
      console.log(
        `[Monitor] ${targetLabel}: ${newActive.length} new active stories queued for delivery.`,
      );
      const deliveredActiveIds = new Set(
        await sendActiveStories({
          stories: mapStories(newActive),
          task: {
            chatId: monitor.telegram_id,
            link: targetLabel,
            linkType: 'username',
            locale: language,
            initTime: Date.now(),
            monitorDelivery: true,
          } as any,
        }),
      );
      recordDeliveredStories(monitor.id, newActive, deliveredActiveIds, 'active');

      // A story may appear in both the active and pinned responses. If the
      // active copy was delivered, record the pinned key too so it is not sent
      // again as a separate pinned alert during the next cycle.
      const pinnedByKey = new Map(
        pinnedStories
          .filter((story: any) => typeof story?.id === 'number' && typeof story?.date === 'number')
          .map((story: any) => [storyKey(story), story]),
      );
      for (const story of newActive) {
        if (!deliveredActiveIds.has(Number(story.id))) continue;
        const pinnedStory = pinnedByKey.get(storyKey(story));
        if (pinnedStory && !persistedPinnedKeys.has(storyKey(story))) {
          markStorySent(
            monitor.id,
            pinnedStory.id,
            pinnedStory.date,
            pinnedStory.expireDate ?? null,
            'pinned',
          );
        }
      }

      if (deliveredActiveIds.size < newActive.length) {
        console.warn(
          `[Monitor] ${targetLabel}: ${newActive.length - deliveredActiveIds.size} active stories were not delivered and will be retried.`,
        );
      }
    }

    if (newPinned.length > 0) {
      console.log(
        `[Monitor] ${targetLabel}: ${newPinned.length} new pinned stories queued for delivery.`,
      );
      const deliveredPinnedIds = new Set(
        await sendActiveStories({
          stories: mapStories(newPinned),
          task: {
            chatId: monitor.telegram_id,
            link: targetLabel,
            linkType: 'username',
            locale: language,
            initTime: Date.now(),
            monitorDelivery: true,
          } as any,
        }),
      );
      recordDeliveredStories(monitor.id, newPinned, deliveredPinnedIds, 'pinned');
      if (deliveredPinnedIds.size < newPinned.length) {
        console.warn(
          `[Monitor] ${targetLabel}: ${newPinned.length - deliveredPinnedIds.size} pinned stories were not delivered and will be retried.`,
        );
      }
    }

    if (newActive.length === 0 && newPinned.length === 0) {
      console.log(`[Monitor] ${targetLabel}: no new stories found.`);
    }

    try {
      if (!checkPhoto) return;
      const photoResponse = await client.invoke(
        new Api.photos.GetUserPhotos({ userId: peer, limit: 1 }),
      );
      const photos = (photoResponse as any)?.photos || [];
      const latest = photos[0];
      const latestId = latest ? String(latest.id) : null;

      if (!latestId && monitor.last_photo_id) {
        // An empty result is not proof of deletion: it is also what a privacy
        // change, a block, or a deleted account returns. Require a second
        // consecutive empty read before telling the subscriber it was removed.
        if (photoAbsenceStreak.get(monitor.id)) {
          photoAbsenceStreak.delete(monitor.id);
          await bot.telegram.sendMessage(
            monitor.telegram_id,
            t(language, 'monitor.photoRemoved', { user: formatMonitorTarget(monitor) }),
          );
          updateMonitorPhoto(monitor.id, null);
        } else {
          photoAbsenceStreak.set(monitor.id, true);
        }
      } else if (latest && latestId && latestId !== monitor.last_photo_id) {
        photoAbsenceStreak.delete(monitor.id);
        try {
          const videoSizes = Array.isArray((latest as any).videoSizes)
            ? (latest as any).videoSizes
            : [];
          const isVideo = videoSizes.length > 0;
          // Select the size explicitly. downloadMedia with no thumb argument
          // merges static sizes and video sizes and returns whichever is
          // largest, so a high-resolution still could be downloaded and then
          // sent as a video (which Telegram rejects).
          const buffer = (await client.downloadMedia(latest as any, {
            thumb: isVideo ? videoSizes[videoSizes.length - 1] : undefined,
          })) as Buffer;
          const caption = `New profile ${isVideo ? 'video' : 'photo'} from ${formatMonitorTarget(monitor)}`;
          if (isVideo) {
            await bot.telegram.sendVideo(
              monitor.telegram_id,
              { source: buffer },
              { caption },
            );
          } else {
            await bot.telegram.sendPhoto(
              monitor.telegram_id,
              { source: buffer },
              { caption },
            );
          }
          // Persist only after Telegram confirms delivery. Failed profile-media
          // notifications are retried on the next monitor cycle.
          updateMonitorPhoto(monitor.id, latestId);
        } catch (error) {
          console.error(
            `[Monitor] Error sending profile media for ${formatMonitorTarget(monitor)}:`,
            error,
          );
        }
      }
    } catch (error) {
      console.error(
        `[Monitor] Error checking profile photo for ${formatMonitorTarget(monitor)}:`,
        error,
      );
    }
  } catch (error) {
    console.error(
      `[Monitor] Error checking ${formatMonitorTarget(monitor)}:`,
      error,
    );
  }

  updateMonitorChecked(id);
}
