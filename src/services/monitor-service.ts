import fs from 'fs';
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
  listSentStoryKeysAmong,
  markStorySent,
  listAllMonitors,
  hasBlockedBot,
  type MonitorRow,
} from '../db';
import {
  ackAllDeletions,
  ackDeletion,
  archiveProfilePhotos,
  clearDeletionAcks,
  downloadProfilePhoto,
  listPendingDeletions,
  purgeOrphanedPhotoArchives,
} from 'services/profile-photo-archive';
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
// One GetUserPhotos call returns up to this many entries. The full history is
// requested (not just the latest) so the archive can record every avatar the
// target still exposes and notice when one disappears.
const PHOTO_HISTORY_LIMIT = 100;
let monitorCycleCount = 0;

/** Everything fetched from Telegram for one target, shared by its subscribers. */
interface TargetSnapshot {
  client: any;
  activeStories: any[];
  pinnedStories: any[];
  /** null when the photo check was skipped this cycle or failed. */
  photos: any[] | null;
}

function photoCheckDue(targetId: string): boolean {
  // Stagger by target so the extra call is spread across cycles rather than
  // fired for every target every hour.
  const salt = Number(String(targetId).slice(-6)) || 0;
  return (monitorCycleCount + salt) % PHOTO_CHECK_EVERY_N_CYCLES === 0;
}

let nextMonitorCheckAt: number | null = null;
let monitorTimer: NodeJS.Timeout | null = null;
// Upper bound for everything done for one target in a cycle (fetch plus the
// deliveries to its subscribers). Telegram calls can hang without rejecting;
// without this bound one stuck target froze the entire hourly loop until the
// next restart. Deliveries are still bounded per story by the download
// timeout; this is the backstop for anything else. Overridable for tests.
const TARGET_CHECK_DEADLINE_MS = Number(process.env.MONITOR_TARGET_DEADLINE_MS) || 15 * 60 * 1000;

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${Math.round(ms / 1000)}s and was abandoned for this cycle`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

// Deliveries that a previous cycle abandoned at the deadline but that are
// still pending underneath (a race cannot cancel the Telegram call). A later
// cycle must not start a second delivery for the same monitor while one is
// in flight, or a late success plus the retry would send the story twice.
const inFlightDeliveries = new Set<number>();

async function deliverBounded(
  monitor: MonitorRow,
  snapshot: TargetSnapshot,
  label: string,
): Promise<void> {
  if (inFlightDeliveries.has(monitor.id)) {
    console.warn(
      `[Monitor] Delivery of ${label} to ${monitor.telegram_id} from an earlier cycle is still in flight; skipping it this cycle.`,
    );
    return;
  }
  inFlightDeliveries.add(monitor.id);
  const delivery = deliverSnapshotToMonitor(monitor, snapshot).finally(() => {
    inFlightDeliveries.delete(monitor.id);
  });
  // If the deadline wins the race, the underlying rejection (if any) must not
  // surface as unhandled later.
  delivery.catch(() => undefined);
  await withDeadline(
    delivery,
    TARGET_CHECK_DEADLINE_MS,
    `[Monitor] Delivering ${label} to ${monitor.telegram_id}`,
  );
}

// Set by stopMonitorLoop() so an in-flight cycle does not reschedule itself.
let monitorStopped = false;
// Incremented by every stopMonitorLoop() call. A running cycle abandons its
// remaining targets only when a stop arrives *during* the cycle; a manual
// /forcemonitor issued while the scheduler is stopped still runs in full and
// simply does not schedule the next automatic cycle.
let stopGeneration = 0;
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
    clearDeletionAcks(existing.id);
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
  stopGeneration += 1;
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
  const generation = stopGeneration;
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

    // Group by target so a profile watched by several subscribers is fetched
    // once per cycle and the result fanned out, instead of once per subscriber.
    const groups = new Map<string, MonitorRow[]>();
    for (const monitor of monitors) {
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
      // A subscriber who blocked the bot cannot receive anything; skip their
      // rows (the monitor is kept and resumes when they unblock).
      if (hasBlockedBot(monitor.telegram_id)) continue;
      const group = groups.get(monitor.target_id);
      if (group) group.push(monitor);
      else groups.set(monitor.target_id, [monitor]);
    }

    let checked = 0;
    for (const [targetId, group] of groups) {
      if (stopGeneration !== generation) {
        console.log('[Monitor] Loop stopped; abandoning the rest of this cycle.');
        break;
      }
      try {
        // Space out targets. Without this the loop issued every request
        // back-to-back and reliably tripped Telegram's per-method flood limits.
        if (checked > 0) {
          await monitorSleep(
            MONITOR_TARGET_DELAY_MS + Math.floor(Math.random() * MONITOR_TARGET_JITTER_MS),
          );
        }
        checked += 1;
        await checkTargetGroup(targetId, group);
      } catch (error) {
        // One bad target must never abort the cycle for everyone else.
        console.error(`[Monitor] Unhandled error while checking target ${targetId}:`, error);
      }
    }

    try {
      purgeOrphanedPhotoArchives();
    } catch (error) {
      console.error('[Monitor] Photo archive purge failed:', error);
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

function buildPeer(monitor: MonitorRow): Api.InputUser {
  return new Api.InputUser({
    userId: bigInt(monitor.target_id),
    accessHash: monitor.target_access_hash
      ? bigInt(monitor.target_access_hash)
      : bigInt.zero,
  });
}

/**
 * Fetches everything the cycle needs for one target: active and pinned
 * stories, and (when due) the profile-photo history. Issued once per target
 * regardless of how many subscribers watch it.
 */
async function fetchTargetSnapshot(
  monitor: MonitorRow,
  includePhotos: boolean,
): Promise<TargetSnapshot> {
  const targetLabel = formatMonitorTarget(monitor);
  const client = await Userbot.getInstance();
  await ensureStealthMode();
  const peer = buildPeer(monitor);

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
    console.error(`[Monitor] Failed to fetch active stories for ${targetLabel}:`, responseResult.reason);
  }
  if (pinnedResult.status === 'rejected') {
    console.error(`[Monitor] Failed to fetch pinned stories for ${targetLabel}:`, pinnedResult.reason);
  }

  const response = responseResult.status === 'fulfilled' ? responseResult.value : null;
  const pinnedResponse = pinnedResult.status === 'fulfilled' ? pinnedResult.value : null;
  const activeStories = (response as any)?.stories?.stories || [];
  const pinnedStories = ((pinnedResponse as any)?.stories || []) as any[];

  let photos: any[] | null = null;
  if (includePhotos) {
    try {
      const photoResponse = await client.invoke(
        new Api.photos.GetUserPhotos({ userId: peer, limit: PHOTO_HISTORY_LIMIT }),
      );
      photos = ((photoResponse as any)?.photos || []) as any[];
      // A PhotosSlice (or a full page) means older photos exist beyond what we
      // fetched, so absence from this page proves nothing.
      const complete =
        !(photoResponse instanceof Api.photos.PhotosSlice) &&
        photos.length < PHOTO_HISTORY_LIMIT;
      try {
        // Marks disappeared photos as deleted; delivery to each subscriber is
        // tracked separately (see listPendingDeletions).
        await archiveProfilePhotos(client, monitor.target_id, photos, complete);
      } catch (error) {
        console.error(`[Monitor] Photo archive failed for ${targetLabel}:`, error);
      }
    } catch (error) {
      console.error(`[Monitor] Error checking profile photo for ${targetLabel}:`, error);
    }
  }

  return { client, activeStories, pinnedStories, photos };
}

function monitorTask(monitor: MonitorRow, language: string) {
  return {
    chatId: monitor.telegram_id,
    link: formatMonitorTarget(monitor),
    linkType: 'username',
    locale: language,
    initTime: Date.now(),
    monitorDelivery: true,
  } as any;
}

/**
 * Compares a target snapshot against what this subscriber has already
 * received and delivers the difference.
 */
async function deliverSnapshotToMonitor(
  monitor: MonitorRow,
  snapshot: TargetSnapshot,
): Promise<void> {
  const targetLabel = formatMonitorTarget(monitor);
  const { activeStories, pinnedStories, client } = snapshot;

  const persistedActiveKeys = new Set(listSentStoryKeys(monitor.id, 'active'));
  const persistedPinnedKeys = new Set(listSentStoryKeys(monitor.id, 'pinned'));

  const newActive = activeStories.filter(
    (story: any) => !persistedActiveKeys.has(storyKey(story)),
  );
  const activeCandidateKeys = new Set(newActive.map(storyKey));
  const validPinned = pinnedStories.filter(
    (story: any) => typeof story?.id === 'number' && typeof story?.date === 'number',
  );
  // The active listing excludes expired deliveries, so a story delivered while
  // active and pinned by its author later would look new once its 24-hour
  // window passed. Check the pinned candidates (and only them) against every
  // delivery ever recorded for this monitor.
  const everSentKeys = new Set(
    listSentStoryKeysAmong(monitor.id, validPinned.map(storyKey)),
  );
  const newPinned = validPinned.filter((story: any) => {
    const key = storyKey(story);
    return (
      !persistedPinnedKeys.has(key) &&
      !persistedActiveKeys.has(key) &&
      !everSentKeys.has(key) &&
      !activeCandidateKeys.has(key)
    );
  });

  const language = findUserById(monitor.telegram_id)?.language || 'en';

  if (newActive.length > 0) {
    console.log(`[Monitor] ${targetLabel}: ${newActive.length} new active stories queued for delivery.`);
    const deliveredActiveIds = new Set(
      await sendActiveStories({ stories: mapStories(newActive), task: monitorTask(monitor, language) }),
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
        markStorySent(monitor.id, pinnedStory.id, pinnedStory.date, pinnedStory.expireDate ?? null, 'pinned');
      }
    }

    if (deliveredActiveIds.size < newActive.length) {
      console.warn(
        `[Monitor] ${targetLabel}: ${newActive.length - deliveredActiveIds.size} active stories were not delivered and will be retried.`,
      );
    }
  }

  if (newPinned.length > 0) {
    console.log(`[Monitor] ${targetLabel}: ${newPinned.length} new pinned stories queued for delivery.`);
    const deliveredPinnedIds = new Set(
      await sendActiveStories({ stories: mapStories(newPinned), task: monitorTask(monitor, language) }),
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

  if (snapshot.photos === null) return;

  try {
    const latest = snapshot.photos[0];
    const latestId = latest ? String(latest.id) : null;
    // Any non-empty history breaks an absence streak, whether or not the
    // latest photo changed; otherwise one old empty read could pair with a
    // much later one and raise a false "removed" alert.
    if (latestId) photoAbsenceStreak.delete(monitor.id);

    if (!latestId && monitor.last_photo_id) {
      // An empty result is not proof of deletion: it is also what a privacy
      // change, a block, or a deleted account returns. Require a second
      // consecutive empty read before telling the subscriber it was removed.
      if (photoAbsenceStreak.get(monitor.id)) {
        photoAbsenceStreak.delete(monitor.id);
        await bot.telegram.sendMessage(
          monitor.telegram_id,
          t(language, 'monitor.photoRemoved', { user: targetLabel }),
        );
        updateMonitorPhoto(monitor.id, null);
      } else {
        photoAbsenceStreak.set(monitor.id, true);
      }
    } else if (latest && latestId && latestId !== monitor.last_photo_id) {
      try {
        const { buffer, isVideo } = await downloadProfilePhoto(client, latest);
        const caption = `New profile ${isVideo ? 'video' : 'photo'} from ${targetLabel}`;
        if (isVideo) {
          await bot.telegram.sendVideo(monitor.telegram_id, { source: buffer }, { caption });
        } else {
          await bot.telegram.sendPhoto(monitor.telegram_id, { source: buffer }, { caption });
        }
        // Persist only after Telegram confirms delivery. Failed profile-media
        // notifications are retried on the next monitor cycle.
        updateMonitorPhoto(monitor.id, latestId);
      } catch (error) {
        console.error(`[Monitor] Error sending profile media for ${targetLabel}:`, error);
      }
    }

    // Photos that vanished from the target's history. Deletions are detected
    // once per target but delivered per subscriber, and acknowledged only after
    // Telegram accepts the send, so a failed or skipped delivery is retried on
    // a later cycle. A monitor that has never been checked takes the current
    // deletions as its baseline instead of receiving them as a backlog.
    if (!monitor.last_checked) {
      ackAllDeletions(monitor.id, monitor.target_id);
    } else {
      for (const photo of listPendingDeletions(monitor.id, monitor.target_id)) {
        try {
          if (photo.file_path && fs.existsSync(photo.file_path)) {
            const caption = t(language, 'monitor.photoDeleted', { user: targetLabel });
            const media = { source: photo.file_path };
            if (photo.is_video) {
              await bot.telegram.sendVideo(monitor.telegram_id, media, { caption });
            } else {
              await bot.telegram.sendPhoto(monitor.telegram_id, media, { caption });
            }
          } else {
            await bot.telegram.sendMessage(
              monitor.telegram_id,
              t(language, 'monitor.photoDeletedNoCopy', { user: targetLabel }),
            );
          }
          ackDeletion(monitor.id, monitor.target_id, photo.photo_id);
        } catch (error) {
          console.error(`[Monitor] Error sending archived photo for ${targetLabel}:`, error);
        }
      }
    }
  } catch (error) {
    console.error(`[Monitor] Error handling profile photo for ${targetLabel}:`, error);
  }
}

/** Checks one target for all of its subscribers with a single fetch. */
async function checkTargetGroup(targetId: string, group: MonitorRow[]): Promise<void> {
  const label = formatMonitorTarget(group[0]);
  console.log(
    `[Monitor] Checking ${label} for ${group.length} subscriber${group.length === 1 ? '' : 's'}.`,
  );
  try {
    // One deadline around everything done for the target, including the
    // username refresh (GetUsers / entity resolution / a notification send),
    // which can hang just like a story fetch.
    await withDeadline(
      (async () => {
        for (const monitor of group) await refreshMonitorUsername(monitor);
        const lead = group.find((monitor) => monitor.target_access_hash) ?? group[0];
        const snapshot = await fetchTargetSnapshot(lead, photoCheckDue(targetId));
        for (const monitor of group) {
          try {
            await deliverBounded(monitor, snapshot, label);
          } catch (error) {
            console.error(
              `[Monitor] Error delivering ${label} to subscriber ${monitor.telegram_id}:`,
              error,
            );
          }
        }
      })(),
      TARGET_CHECK_DEADLINE_MS,
      `[Monitor] Checking ${label}`,
    );
  } catch (error) {
    console.error(`[Monitor] Error checking ${label}:`, error);
  } finally {
    for (const monitor of group) updateMonitorChecked(monitor.id);
  }
}

/**
 * Checks one monitor row: refreshes the target, fetches a snapshot and
 * delivers it to that subscriber. Used by direct callers (and tests); the
 * hourly loop goes through checkTargetGroup so shared targets are fetched once.
 *
 * @param checkPhoto Whether to include the photo-history call.
 */
export async function checkSingleMonitor(
  id: number,
  checkPhoto = true,
): Promise<void> {
  const monitor = getMonitor(id);
  if (!monitor) return;

  try {
    console.log(
      `[Monitor] Checking ${formatMonitorTarget(monitor)} for subscriber ${monitor.telegram_id}.`,
    );
    await withDeadline(
      (async () => {
        await refreshMonitorUsername(monitor);
        const label = formatMonitorTarget(monitor);
        const snapshot = await fetchTargetSnapshot(monitor, checkPhoto);
        await deliverBounded(monitor, snapshot, label);
      })(),
      TARGET_CHECK_DEADLINE_MS,
      `[Monitor] Checking ${formatMonitorTarget(monitor)}`,
    );
  } catch (error) {
    console.error(`[Monitor] Error checking ${formatMonitorTarget(monitor)}:`, error);
  } finally {
    updateMonitorChecked(id);
  }
}
