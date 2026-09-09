import fs from 'fs';
import { Api } from 'telegram';
import bigInt from 'big-integer';
import { Userbot } from '../config/userbot';
import {
  addMonitor,
  removeMonitor,
  findMonitorByUsername,
  findMonitorByTargetId,
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
  listAccessHashesForTarget,
  deletePendingUsernameNotice,
  listPendingUsernameNotices,
  markPendingUsernameNoticeAttempted,
  updateMonitorUsernameClearingNotice,
  updateMonitorUsernameWithPendingNotice,
  type MonitorRow,
  type PendingUsernameNotice,
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

/**
 * Thrown by withDeadline() when the deadline, rather than the awaited work,
 * won the race. Callers that must tell the two apart (the notice send, whose
 * underlying request may still be delivered) check for this class; the others
 * only log, so the change is invisible to them.
 */
class DeadlineExceeded extends Error {}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DeadlineExceeded(`${label} exceeded ${Math.round(ms / 1000)}s and was abandoned for this cycle`)),
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

// When the userbot connection is known to be down, a cycle is skipped and
// retried after this delay rather than walking every target into its deadline
// or waiting a full hour.
const UNHEALTHY_RETRY_MS = 10 * 60 * 1000;

// Some test doubles of the Userbot expose only getInstance; treat them as healthy.
function userbotHealthy(): boolean {
  const probe = (Userbot as any)?.isHealthy;
  return typeof probe === 'function' ? Boolean(probe.call(Userbot)) : true;
}

function scheduleNextMonitorCheck(startedAt?: number, overrideDelayMs?: number) {
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
  const delayMs = overrideDelayMs ?? Math.max(0, dueAt - Date.now());
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

/** Every handle Telegram currently reports as active for the account. */
function activeHandles(user: any): string[] {
  const handles: string[] = [];
  if (user?.username) handles.push(String(user.username));
  const list: any[] = Array.isArray(user?.usernames) ? user.usernames : [];
  for (const entry of list) {
    if (entry?.active && entry?.username) handles.push(String(entry.username));
  }
  return handles;
}

/**
 * Telegram accounts can carry several usernames (including purchased
 * collectible ones). In that case `user.username` is often empty and the
 * active handle lives in `user.usernames`. When the handle we already hold
 * (the alias the subscriber typed, or the stored label) is still one of the
 * account's active handles it is kept, so /unmonitor by that alias keeps
 * working and a multi-handle account does not churn "changed username"
 * notices. Otherwise prefer the main field, then the active editable handle,
 * then any active one. Returns null when the account has no username at all.
 */
export function resolveUsername(user: any, preferred?: string | null): string | null {
  const handles = activeHandles(user);
  if (preferred && !isPhoneLabel(preferred)) {
    const wanted = preferred.toLowerCase();
    const kept = handles.find((handle) => handle.toLowerCase() === wanted);
    if (kept) return kept;
  }
  if (user?.username) return String(user.username);
  const list: any[] = Array.isArray(user?.usernames) ? user.usernames : [];
  const active = list.find((u) => u?.active && u?.editable) ?? list.find((u) => u?.active);
  return active?.username ? String(active.username) : null;
}

// Monitors added by phone number store the number as their label; it is not a
// username and must never be treated as one that has been removed.
function isPhoneLabel(label: string | null | undefined): boolean {
  return typeof label === 'string' && label.startsWith('+');
}

/**
 * Telegram (and gramJS) report a handle that no longer resolves with one of
 * these. Only then is a lookup by account id a sensible retry; a timeout,
 * flood wait or auth error must propagate rather than trigger a second
 * request against an already struggling connection.
 */
export function isUsernameGoneError(error: unknown): boolean {
  const code = String((error as any)?.errorMessage ?? '');
  if (code === 'USERNAME_INVALID' || code === 'USERNAME_NOT_OCCUPIED') return true;
  const message = String((error as any)?.message ?? error ?? '');
  return (
    /USERNAME_INVALID|USERNAME_NOT_OCCUPIED/.test(message) ||
    /No user has ".*" as username/.test(message) ||
    /Cannot find any entity corresponding to/.test(message) ||
    /Could not find the input entity/.test(message)
  );
}

/**
 * A notice that can never be delivered (the subscriber blocked the bot,
 * deleted their account, or the chat is gone) must not hold the stored label
 * hostage; anything else is transient and worth retrying on the next refresh.
 */
function isPermanentDeliveryFailure(error: unknown): boolean {
  const code = Number((error as any)?.response?.error_code ?? (error as any)?.code);
  if (code === 403) return true;
  const description = String(
    (error as any)?.response?.description ?? (error as any)?.description ?? (error as any)?.message ?? '',
  );
  return /bot was blocked|user is deactivated|chat not found|bot can't initiate|PEER_ID_INVALID/i.test(
    description,
  );
}

// Notices that a previous cycle abandoned at its deadline but that are still
// pending underneath (the race cannot cancel the Telegram call). No second
// send may start for the same monitor while one is in flight, or a late
// success plus the retry would tell the subscriber twice; the pending row is
// simply left for the next replay. The value is when the attempt started: a
// send that never settles at all would otherwise pin its monitor for the life
// of the process and its row would never be retried (see noticeInFlight).
const inFlightNotices = new Map<number, number>();

// Read per call so tests can shorten it; 30s is well inside the target deadline.
function noticeSendTimeoutMs(): number {
  return Number(process.env.MONITOR_NOTICE_TIMEOUT_MS) || 30 * 1000;
}

// How long an unsettled send may hold its monitor's slot. Long enough that a
// merely slow Telegram call is never treated as gone, short enough that a
// send which never settles delays its monitor's next notice by one cycle
// rather than for good.
function noticeInFlightMaxMs(): number {
  return Number(process.env.MONITOR_NOTICE_INFLIGHT_MAX_MS) || 10 * 60 * 1000;
}

/**
 * Whether a notice for this monitor is still genuinely in flight. An entry
 * older than the bound above is abandoned: its promise may never settle (a
 * Telegram call can hang indefinitely), and keeping it would block every
 * later send for that monitor for good. The entry is dropped so the caller
 * can proceed as if nothing were pending.
 */
function noticeInFlight(monitorId: number): boolean {
  const startedAt = inFlightNotices.get(monitorId);
  if (startedAt === undefined) return false;
  if (Date.now() - startedAt < noticeInFlightMaxMs()) return true;
  console.warn(
    `[Monitor] A username notice for monitor ${monitorId} has been in flight for over ${Math.round(
      noticeInFlightMaxMs() / 1000,
    )}s; treating it as abandoned so later notices are not blocked.`,
  );
  inFlightNotices.delete(monitorId);
  return false;
}

/** A label for the logs; the monitor may already be gone when a send settles. */
function noticeTargetLabel(monitorId: number, telegramId: string): string {
  const monitor = getMonitor(monitorId);
  return monitor ? formatMonitorTarget(monitor) : `monitor ${monitorId} (${telegramId})`;
}

/**
 * Delivers one outbox row: the single place a username notice is ever sent.
 * The row is the intent; this only reconciles it with what Telegram says.
 *
 * The row is claimed (stamped as tried) before the send starts, so a send
 * that hangs rotates its row behind the untried ones instead of filling every
 * capped replay batch from now on. The send is then raced against a deadline
 * that only bounds how long the caller waits: an abandoned send can still be
 * accepted by Telegram, so the row survives until the send actually settles,
 * and the settlement below clears it whichever way it goes.
 *
 * Every delete is scoped to this attempt. A newer observation replaces the
 * row with a fresh token, so a late settlement can never discard a notice
 * nobody has sent yet.
 *
 * The claim is also what decides whether to send at all. A replay awaits its
 * rows one at a time from a snapshot, so by the time one is reached its row
 * may already be gone (its own timed-out send settled) or replaced by a newer
 * observation. The claim then matches nothing, and sending the snapshot would
 * repeat a notice already delivered or announce a transition since
 * superseded. Returns whether a send was actually started.
 */
async function attemptPendingNotice(row: PendingUsernameNotice): Promise<boolean> {
  const monitorId = row.monitor_id;
  const label = noticeTargetLabel(monitorId, row.telegram_id);
  const claimed = markPendingUsernameNoticeAttempted(
    monitorId,
    row.attempt,
    nextNoticeAttemptStamp(),
  );
  if (claimed === 0) {
    // Nothing to reconcile: whatever this row described has been settled or
    // superseded since it was read. Registering it as in flight would only
    // block the row that replaced it.
    console.log(
      `[Monitor] The username notice for ${label} was already settled or superseded before it could be sent; skipping it.`,
    );
    return false;
  }
  const startedAt = Date.now();
  inFlightNotices.set(monitorId, startedAt);
  const settled = (async () => {
    try {
      await bot.telegram.sendMessage(row.telegram_id, row.text);
      // Delivered: the intent is discharged.
      deletePendingUsernameNotice(monitorId, row.attempt);
    } catch (err) {
      if (isPermanentDeliveryFailure(err)) {
        // Nothing will ever deliver it; replaying it every cycle would only
        // hammer a chat that is gone. The label stays as recorded.
        console.warn(
          `[Monitor] Username notice for ${label} is undeliverable; dropping it and keeping the recorded change:`,
          (err as any)?.message ?? err,
        );
        deletePendingUsernameNotice(monitorId, row.attempt);
        return;
      }
      // Transient: the row stays, carrying the stamp written above, and the
      // next replay picks it up.
      console.warn(
        `[Monitor] Username notice for ${label} could not be delivered; it stays in the outbox for the next cycle:`,
        (err as any)?.message ?? err,
      );
    }
  })().finally(() => {
    // Only this attempt's entry may be cleared. If the entry was already
    // expired and replaced, a late settlement must not free a newer send's
    // slot and let a duplicate go out alongside it.
    if (inFlightNotices.get(monitorId) === startedAt) inFlightNotices.delete(monitorId);
  });
  // A failure inside the settlement (a database error, say) must not resurface
  // as an unhandled rejection once the deadline has won the race below.
  settled.catch(() => undefined);
  try {
    await withDeadline(
      settled,
      noticeSendTimeoutMs(),
      `[Monitor] Username notice to ${row.telegram_id}`,
    );
  } catch (err) {
    if (err instanceof DeadlineExceeded) {
      console.warn(
        `[Monitor] Username notice for ${label} is still pending after the send deadline; it stays in the outbox until the send settles.`,
      );
      return true;
    }
    throw err;
  }
  return true;
}

// A notice nobody could deliver for a week is not worth announcing any more:
// the handle it describes has probably changed again since.
const NOTICE_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;
// Replay is a catch-up, not the main job of a cycle; a backlog is drained
// over several cycles rather than delaying every target check. Read per call
// so tests can shrink the batch.
function maxNoticeReplaysPerCycle(): number {
  return Number(process.env.MONITOR_NOTICE_REPLAY_BATCH) || 50;
}

// Strictly increasing stamps for the claim a send writes before it starts.
// Date.now() alone is not enough: several attempts in one cycle can land in
// the same millisecond, and the replay order would then no longer rotate them.
let lastNoticeAttemptStamp = 0;
function nextNoticeAttemptStamp(): number {
  const now = Date.now();
  lastNoticeAttemptStamp = now > lastNoticeAttemptStamp ? now : lastNoticeAttemptStamp + 1;
  return lastNoticeAttemptStamp;
}

/**
 * Whether this subscriber may still receive monitoring output: premium, the
 * bot admin, or a live Stars entitlement. forceCheckMonitors removes the
 * monitors of everyone else; the notice replay runs before that
 * reconciliation and so applies the very same test itself, or an expired
 * subscriber would still be told about a handle change.
 */
function isMonitorSubscriberEligible(
  telegramId: string,
  premiumCache?: Map<string, boolean>,
): boolean {
  let premium = premiumCache?.get(telegramId);
  if (premium === undefined) {
    premium = isUserPremium(telegramId);
    premiumCache?.set(telegramId, premium);
  }
  const starsEntitlement = getStarsMonitoringEntitlement(telegramId);
  return premium || Number(telegramId) === BOT_ADMIN_ID || Boolean(starsEntitlement);
}

/**
 * Re-sends the notices whose sends never reached a confirmed outcome before
 * the process ended. The label these notices describe is already stored, so
 * no later refresh would ever observe the difference again: without this the
 * subscriber is simply never told.
 *
 * A cycle runs this in one of two places, never both:
 *
 * - Userbot unhealthy: before the health gate returns early. Replaying needs
 *   only the bot API, and during an outage lasting days the cycle returns
 *   early every time, so a replay placed after the gate would never run until
 *   the rows aged out and were discarded unsent.
 * - Userbot healthy: after the target loop, so every monitor's
 *   refreshMonitorUsername has already run. A leftover row can describe a
 *   state the account has since left — a pending "dropped their username"
 *   notice for an account that has a handle again — and that refresh is what
 *   clears it, silently, on the null-to-handle transition. Replaying first
 *   would send the obsolete notice, and the silent transition means nothing
 *   would ever correct it. Notices created during the cycle are attempted
 *   immediately by the persist path, so only leftovers wait for this.
 *
 * Each row is only sent to a subscriber still entitled to monitoring: on the
 * unhealthy path the cycle's own entitlement reconciliation never runs, and
 * on the healthy path a row for a removed monitor is dropped here anyway.
 *
 * Accepted trade-off: if Telegram accepted the message and the process died
 * before the row could be deleted, the subscriber gets the notice twice.
 * Announcing a handle change twice is much cheaper than never announcing it,
 * and only a crash in that narrow window produces it.
 */
export async function replayPendingUsernameNotices(): Promise<void> {
  let pending: PendingUsernameNotice[];
  try {
    pending = listPendingUsernameNotices();
  } catch (error) {
    console.error('[Monitor] Could not read the pending username notices:', error);
    return;
  }
  // The cap bounds the work a cycle does, so only rows this actually tries to
  // send count against it. A fixed slice of the ordered list let a run of rows
  // that are merely held (blocked, ineligible, in flight) or dropped fill every
  // batch without ever touching last_attempt_at, so they were re-selected each
  // cycle and the deliverable rows behind them waited until they aged out.
  const budget = maxNoticeReplaysPerCycle();
  let attempted = 0;
  for (const row of pending) {
    if (attempted >= budget) break;
    // One bad row must never abort the cycle for everyone else.
    try {
      // A send started by this process is still running; it will clear the row.
      if (noticeInFlight(row.monitor_id)) continue;
      const monitor = getMonitor(row.monitor_id);
      if (!monitor) {
        deletePendingUsernameNotice(row.monitor_id, row.attempt);
        continue;
      }
      if (Date.now() - row.created_at > NOTICE_GIVE_UP_MS) {
        console.warn(
          `[Monitor] Giving up on the username notice for ${formatMonitorTarget(monitor)}: it has been undeliverable for over 7 days.`,
        );
        deletePendingUsernameNotice(row.monitor_id, row.attempt);
        continue;
      }
      if (hasBlockedBot(row.telegram_id)) {
        // Nothing can reach this subscriber right now. The row is kept, as
        // for an ineligible one: they may unblock, removeMonitor takes the
        // row with it if they do not, and the give-up above bounds the wait.
        console.log(
          `[Monitor] Holding the username notice for ${formatMonitorTarget(monitor)}: ${row.telegram_id} has blocked the bot.`,
        );
        continue;
      }
      if (!isMonitorSubscriberEligible(row.telegram_id)) {
        // Replay runs before this cycle reconciles entitlements, so an
        // expired subscriber would otherwise still be sent a monitoring
        // update. The row is left alone rather than dropped: the
        // reconciliation below removes the monitor, and removeMonitor takes
        // the owed notice with it, while a subscriber who renews in the
        // meantime still gets told.
        console.log(
          `[Monitor] Holding the username notice for ${formatMonitorTarget(monitor)}: ${row.telegram_id} is no longer entitled to monitoring.`,
        );
        continue;
      }
      // Counted before the send: a row whose send throws or hangs has still
      // used a slot of this cycle's budget. A row whose claim no longer
      // matches never started one — it was settled or replaced while an
      // earlier row in this snapshot was being sent — so it gives the slot
      // back and the row that replaced it waits for the next cycle.
      attempted += 1;
      const started = await attemptPendingNotice(row);
      if (!started) attempted -= 1;
    } catch (error) {
      console.error(
        `[Monitor] Could not replay the username notice for monitor ${row.monitor_id}:`,
        (error as any)?.message ?? error,
      );
    }
  }
}

/**
 * Records what was observed. The label is written unconditionally, together
 * with the notice owed for it, and nothing here is ever undone: the outbox
 * row, not the label, is what remembers that a subscriber still has to be
 * told, so a send that fails, hangs or is abandoned costs nothing but a
 * retry. Persisting first also means a failing write can never leave a
 * subscriber receiving the same notice every hour, which is what happened
 * when a legacy NOT NULL on the column rejected the update after the notice
 * had already gone out.
 *
 * A transition worth no notice (a label acquired where there was none)
 * clears whatever was pending instead: a "dropped their username" notice
 * describes a state the account has already left.
 *
 * Each observation supersedes the last, so the newest row always carries the
 * newest text under a fresh attempt token; an older send still in flight can
 * no longer affect it, because every delete it makes is scoped to its own
 * attempt. The immediate send below is only for promptness — if one is
 * already in flight for this monitor, the next cycle's replay delivers the
 * new row instead.
 */
async function persistUsernameAfterNotice(
  monitor: MonitorRow,
  newUsername: string | null,
  notice: string | null,
): Promise<void> {
  if (!notice) {
    updateMonitorUsernameClearingNotice(monitor.id, newUsername);
    monitor.target_username = newUsername;
    return;
  }
  const createdAt = Date.now();
  const attempt = updateMonitorUsernameWithPendingNotice(
    monitor.id,
    newUsername,
    monitor.telegram_id,
    notice,
    createdAt,
  );
  monitor.target_username = newUsername;
  if (hasBlockedBot(monitor.telegram_id)) {
    // The row waits in the outbox for them to unblock, exactly as replay
    // treats one it finds for a blocked subscriber.
    return;
  }
  if (noticeInFlight(monitor.id)) {
    console.log(
      `[Monitor] A username notice for ${formatMonitorTarget(monitor)} is still in flight; the next replay delivers the one recorded now.`,
    );
    return;
  }
  await attemptPendingNotice({
    monitor_id: monitor.id,
    telegram_id: monitor.telegram_id,
    text: notice,
    created_at: createdAt,
    attempt,
    last_attempt_at: null,
  });
}

/**
 * Telegram's answer that the (id, access hash) pair itself is bad, or our own
 * "no user came back" marker. Only these justify treating a borrowed access
 * hash as rejected; a timeout or flood wait must propagate unchanged.
 */
function isInvalidPeerError(error: unknown): boolean {
  const code = String((error as any)?.errorMessage ?? '');
  if (code === 'USER_ID_INVALID' || code === 'PEER_ID_INVALID') return true;
  const message = String((error as any)?.message ?? error ?? '');
  return /USER_ID_INVALID|PEER_ID_INVALID|returned no user/.test(message);
}

function isUserEntity(entity: any): boolean {
  return entity instanceof Api.User || entity?.className === 'User';
}

function isEmptyUser(user: any): boolean {
  return user instanceof Api.UserEmpty || user?.className === 'UserEmpty';
}

/**
 * The stored handle is gone, no access hash is known, and Telegram cannot
 * resolve the bare id either: nothing this row could ever fetch again. Say so
 * and free the slot rather than claiming that monitoring continues. The
 * notice goes first; a transient send failure leaves the row for the next
 * refresh to retry, a permanent one (blocked bot, dead chat) does not.
 */
async function stopUnresolvableMonitor(monitor: MonitorRow): Promise<void> {
  console.warn(
    `[Monitor] ${formatMonitorTarget(monitor)} no longer resolves and no access hash is stored; stopping this monitor.`,
  );
  if (!hasBlockedBot(monitor.telegram_id)) {
    const language = findUserById(monitor.telegram_id)?.language;
    try {
      await bot.telegram.sendMessage(
        monitor.telegram_id,
        t(language, 'monitor.unresolvable', {
          old: `@${monitor.target_username}`,
          user: monitor.target_id,
        }),
      );
    } catch (err) {
      if (!isPermanentDeliveryFailure(err)) throw err;
    }
  }
  await removeProfileMonitor(monitor.telegram_id, monitor.target_id);
}

async function notifyUsernameRemoved(monitor: MonitorRow): Promise<void> {
  const oldUsername = monitor.target_username;
  if (!oldUsername) {
    await persistUsernameAfterNotice(monitor, null, null);
    return;
  }
  const language = findUserById(monitor.telegram_id)?.language;
  const notice = t(language, 'monitor.usernameRemoved', {
    old: `@${oldUsername}`,
    user: formatMonitorTarget({ ...monitor, target_username: null }),
  });
  await persistUsernameAfterNotice(monitor, null, notice);
}

/**
 * Reconciles what Telegram reports for the target with the stored label.
 * A new handle is recorded and announced; a handle that has disappeared is
 * cleared and announced too, so captions stop linking to an account that
 * "doesn't seem to exist". Previously only the first case was handled.
 */
async function applyUsernameObservation(
  monitor: MonitorRow,
  username: string | null,
): Promise<void> {
  if (username) {
    if (username === monitor.target_username) return;
    if (username.toLowerCase() === (monitor.target_username ?? '').toLowerCase()) {
      // Same handle, different casing: record Telegram's spelling quietly.
      // The outbox is deliberately left alone. A notice pending here
      // describes a real transition nobody has been told about yet, and a
      // change of spelling does not make it untrue, so clearing it would drop
      // an announcement that is still owed.
      updateMonitorUsername(monitor.id, username);
      monitor.target_username = username;
      return;
    }
    await notifyUsernameChange(monitor, username);
    return;
  }
  if (monitor.target_username && !isPhoneLabel(monitor.target_username)) {
    await notifyUsernameRemoved(monitor);
  }
}

async function notifyUsernameChange(
  monitor: MonitorRow,
  newUsername: string,
): Promise<void> {
  const oldUsername = monitor.target_username;
  if (!oldUsername) {
    await persistUsernameAfterNotice(monitor, newUsername, null);
    return;
  }
  const language = findUserById(monitor.telegram_id)?.language;
  const format = (username: string) => (username.startsWith('+') ? username : `@${username}`);
  const notice = t(language, 'monitor.usernameChanged', {
    old: format(oldUsername),
    user: format(newUsername),
  });
  await persistUsernameAfterNotice(monitor, newUsername, notice);
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
  // The account may already be monitored under another of its handles (or
  // by phone / id). The insert below would be ignored and the existing row
  // returned, so callers would announce a start that never happened.
  if (findMonitorByTargetId(telegramId, targetId)) return null;
  const targetUsername = resolveUsername(entity, username) || username;
  return addMonitor(telegramId, targetId, targetUsername, accessHash);
}

export async function removeProfileMonitor(
  telegramId: string,
  target: string,
): Promise<boolean> {
  // Private or username-less monitors are displayed and removed by target ID.
  // Resolve both forms here so every caller shares the same authorization and
  // deletion path instead of reporting success for an unchanged monitor row.
  const wanted = target.replace(/^@/, '').toLowerCase();
  let existing =
    findMonitorByUsername(telegramId, target) ||
    listMonitors(telegramId).find((monitor) => monitor.target_id === target) ||
    listMonitors(telegramId).find(
      (monitor) => (monitor.target_username ?? '').toLowerCase() === wanted,
    );
  if (!existing && wanted && !/^\d+$/.test(wanted)) {
    // The subscriber may use another of the account's handles than the one
    // stored (collectible alias vs. main handle). Resolve it to the account
    // id before giving up. Only a username-not-found answer means "not
    // found"; a timeout, flood wait or disconnected userbot propagates so the
    // caller can report an error instead of a misleading "not found".
    try {
      const entity: any = await getEntityWithTempContact(target.replace(/^@/, ''));
      // User, chat and channel ids are separate namespaces that can share a
      // numeric value; only a user may be matched against user monitors.
      if (isUserEntity(entity)) {
        const targetId = String(entity.id);
        existing = listMonitors(telegramId).find((monitor) => monitor.target_id === targetId);
      }
    } catch (lookupError) {
      if (!isUsernameGoneError(lookupError)) throw lookupError;
      existing = undefined;
    }
  }
  if (!existing) return false;

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
  return true;
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

/**
 * Replays the outbox for a cycle, where a failure must never abort or fail the
 * cycle itself. Called from exactly one of the two places described on
 * replayPendingUsernameNotices, depending on the userbot's health.
 */
async function replayLeftoverUsernameNotices(): Promise<void> {
  try {
    await replayPendingUsernameNotices();
  } catch (error) {
    console.error('[Monitor] Replaying pending username notices failed:', error);
  }
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
  if (!userbotHealthy()) {
    // Nothing will refresh a label this cycle, and replaying needs only the
    // bot API: send the leftovers now rather than let them age out through an
    // outage that returns early every time.
    await replayLeftoverUsernameNotices();
    console.warn(
      `[Monitor] Userbot connection is unhealthy; skipping this cycle and retrying in ${UNHEALTHY_RETRY_MS / 60000} minutes.`,
    );
    monitorRunning = false;
    scheduleNextMonitorCheck(undefined, UNHEALTHY_RETRY_MS);
    return 0;
  }
  let abortedUnhealthy = false;
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
      if (!isMonitorSubscriberEligible(monitor.telegram_id, premiumCache)) {
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
      if (!userbotHealthy()) {
        console.warn('[Monitor] Userbot connection became unhealthy; abandoning the rest of this cycle.');
        abortedUnhealthy = true;
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

    // Only now, with every monitor's refresh done: a leftover notice that
    // describes a state the account has already left has been cleared by that
    // refresh, so replaying here cannot send an obsolete one.
    await replayLeftoverUsernameNotices();

    try {
      purgeOrphanedPhotoArchives();
    } catch (error) {
      console.error('[Monitor] Photo archive purge failed:', error);
    }
  } finally {
    monitorRunning = false;
    scheduleNextMonitorCheck(startedAt, abortedUnhealthy ? UNHEALTHY_RETRY_MS : undefined);
  }
  return monitors.length;
}

/**
 * Reconciles the stored label and access hash with Telegram. Resolves to
 * false only when the monitor was stopped because it can no longer be
 * resolved at all; callers must then skip the story fetch and delivery for
 * that row.
 */
export async function refreshMonitorUsername(monitor: MonitorRow): Promise<boolean> {
  const last = usernameRefreshTimes.get(monitor.id) || 0;
  if (Date.now() - last < USERNAME_REFRESH_INTERVAL_MS) return true;
  usernameRefreshTimes.set(monitor.id, Date.now());

  try {
    // Candidate hashes to probe with: the row's own, or, for a hash-less
    // row, every distinct hash other subscribers' rows hold for this account
    // (all obtained by this userbot). A borrowed hash is persisted only once
    // Telegram has accepted it, so a stale sibling value cannot poison an
    // otherwise recoverable row, and every candidate is tried before the
    // label/id fallbacks are considered.
    const own = monitor.target_access_hash || null;
    const candidates = own ? [own] : listAccessHashesForTarget(monitor.target_id);
    // Only the probe itself is covered by borrowed-hash recovery. The
    // username reconciliation (which may send a notice) runs afterwards, so
    // a transient send failure is handled by the outer catch as before and
    // is never mistaken for a rejected access hash.
    let probed: any = null;
    let acceptedHash: string | null = null;
    for (const candidate of candidates) {
      try {
        const client = await Userbot.getInstance();
        const response = await client.invoke(
          new Api.users.GetUsers({
            id: [
              new Api.InputUser({
                userId: bigInt(monitor.target_id),
                accessHash: bigInt(candidate),
              }),
            ],
          }),
        );
        const user = Array.isArray(response) ? response[0] : response;
        if (!user || isEmptyUser(user)) {
          throw new Error(`[Monitor] users.GetUsers returned no user for ${monitor.target_id}`);
        }
        probed = user;
        acceptedHash = candidate;
        break;
      } catch (hashError) {
        // The row's own hash, or any failure that is not Telegram rejecting
        // the (id, hash) pair, propagates unchanged: a timeout or flood wait
        // must never cascade into the give-up paths below.
        if (own || !isInvalidPeerError(hashError)) throw hashError;
        console.warn(
          `[Monitor] Borrowed access hash for ${formatMonitorTarget(monitor)} was rejected; trying the next candidate:`,
          (hashError as any)?.message ?? hashError,
        );
      }
    }
    if (probed) {
      // The hash has just been accepted by Telegram: persist it first so the
      // row is resolvable even if the notice below fails and is retried.
      const accessHash = probed.accessHash ? String(probed.accessHash) : acceptedHash;
      if (accessHash && accessHash !== monitor.target_access_hash) {
        updateMonitorAccessHash(monitor.id, accessHash);
        monitor.target_access_hash = accessHash;
      }
      await applyUsernameObservation(monitor, resolveUsername(probed, monitor.target_username));
      return true;
    }

    // Without an access hash the target is resolved by label. If the stored
    // handle has been dropped that lookup fails with a username error, and
    // only then is the id tried instead; other failures propagate as before.
    let entity: any;
    try {
      entity = await getEntityWithTempContact(monitor.target_username || monitor.target_id);
    } catch (lookupError) {
      if (
        !monitor.target_username ||
        isPhoneLabel(monitor.target_username) ||
        !isUsernameGoneError(lookupError)
      ) {
        throw lookupError;
      }
      try {
        entity = await getEntityWithTempContact(monitor.target_id);
      } catch (idError) {
        if (!isUsernameGoneError(idError)) throw idError;
        // Neither the handle nor the bare id resolves. Without an access hash
        // Telegram cannot look the account up after a restart (the string
        // session keeps no entity cache), and every story request for this
        // row would fail the same way, so stop it with an honest notice.
        await stopUnresolvableMonitor(monitor);
        return false;
      }
    }
    const username = resolveUsername(entity, monitor.target_username);
    const idString = String((entity as any).id);
    const accessHash = (entity as any).accessHash
      ? String((entity as any).accessHash)
      : null;

    await applyUsernameObservation(monitor, username);
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
  return true;
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
        const remaining: MonitorRow[] = [];
        for (const monitor of group) {
          if (await refreshMonitorUsername(monitor)) remaining.push(monitor);
        }
        // A monitor stopped during the refresh must not be fetched for or
        // delivered to: its rows are gone and its peer is unresolvable.
        if (!remaining.length) return;
        const lead = remaining.find((monitor) => monitor.target_access_hash) ?? remaining[0];
        const snapshot = await fetchTargetSnapshot(lead, photoCheckDue(targetId));
        for (const monitor of remaining) {
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
        if (!(await refreshMonitorUsername(monitor))) return;
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
