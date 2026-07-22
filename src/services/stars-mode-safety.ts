import type { Telegraf } from 'telegraf';
import { db } from 'db';
import { IContextBot } from 'config/context-interface';

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MONTH_SECONDS = 30 * 24 * 60 * 60;
const MONITOR_INTERVAL_MS = 60 * 60 * 1000;

let monitorTimer: NodeJS.Timeout | null = null;
let monitorCycleRunning = false;
let launchPatched = false;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function setSetting(key: string, value: string, updatedBy: string): void {
  db.prepare(
    `INSERT INTO bot_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(key, value, nowSeconds(), updatedBy);
}

function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM bot_settings WHERE key = ?').get(key) as
    | { value?: string }
    | undefined;
  return row?.value;
}

function initializeSafetySchema(): void {
  const now = nowSeconds();
  db.exec(`
    CREATE TABLE IF NOT EXISTS star_monitor_entitlements (
      user_id TEXT PRIMARY KEY NOT NULL,
      expires_at INTEGER NOT NULL,
      max_targets INTEGER NOT NULL DEFAULT 3,
      plan TEXT NOT NULL,
      last_bundle_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS star_monitor_delete_authorizations (
      telegram_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      authorized_at INTEGER NOT NULL,
      PRIMARY KEY (telegram_id, target_id)
    );

    CREATE TRIGGER IF NOT EXISTS bind_star_bundle_requesting_user
    AFTER INSERT ON star_result_bundles
    WHEN json_extract(NEW.task_json, '$.user.id') IS NOT NULL
    BEGIN
      UPDATE star_result_bundles
      SET user_id = CAST(json_extract(NEW.task_json, '$.user.id') AS TEXT)
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS fulfill_star_monitor_purchase
    AFTER UPDATE OF status ON star_result_bundles
    WHEN NEW.status = 'PAID'
      AND NEW.request_kind IN ('monitor_week', 'monitor_month')
    BEGIN
      INSERT INTO star_monitor_entitlements (
        user_id, expires_at, max_targets, plan, last_bundle_id, updated_at
      ) VALUES (
        NEW.user_id,
        CAST(strftime('%s','now') AS INTEGER) +
          CASE NEW.request_kind
            WHEN 'monitor_week' THEN ${WEEK_SECONDS}
            ELSE ${MONTH_SECONDS}
          END,
        3,
        NEW.request_kind,
        NEW.id,
        CAST(strftime('%s','now') AS INTEGER)
      )
      ON CONFLICT(user_id) DO UPDATE SET
        expires_at =
          CASE
            WHEN star_monitor_entitlements.expires_at > CAST(strftime('%s','now') AS INTEGER)
              THEN star_monitor_entitlements.expires_at
            ELSE CAST(strftime('%s','now') AS INTEGER)
          END +
          CASE NEW.request_kind
            WHEN 'monitor_week' THEN ${WEEK_SECONDS}
            ELSE ${MONTH_SECONDS}
          END,
        max_targets = 3,
        plan = NEW.request_kind,
        last_bundle_id = NEW.id,
        updated_at = CAST(strftime('%s','now') AS INTEGER);

      UPDATE star_result_bundles
      SET status = 'DELIVERED',
          delivered_at = CAST(strftime('%s','now') AS INTEGER),
          last_error = NULL
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS revoke_latest_star_monitor_refund
    AFTER UPDATE OF refunded_at ON star_payments
    WHEN NEW.refunded_at IS NOT NULL
    BEGIN
      DELETE FROM star_monitor_entitlements
      WHERE last_bundle_id = NEW.bundle_id;
    END;

    CREATE TRIGGER IF NOT EXISTS preserve_active_star_monitors
    BEFORE DELETE ON monitors
    WHEN EXISTS (
      SELECT 1 FROM star_monitor_entitlements e
      WHERE e.user_id = OLD.telegram_id
        AND e.expires_at > CAST(strftime('%s','now') AS INTEGER)
    )
    AND NOT EXISTS (
      SELECT 1 FROM star_monitor_delete_authorizations a
      WHERE a.telegram_id = OLD.telegram_id
        AND a.target_id = OLD.target_id
    )
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);

  db.prepare(
    `INSERT OR IGNORE INTO bot_settings (key, value, updated_at, updated_by)
     VALUES ('stars_monitor_week_price', '199', ?, 'migration')`,
  ).run(now);
  db.prepare(
    `INSERT OR IGNORE INTO bot_settings (key, value, updated_at, updated_by)
     VALUES ('stars_monitor_month_price', '499', ?, 'migration')`,
  ).run(now);
  db.prepare(
    `INSERT OR IGNORE INTO bot_settings (key, value, updated_at, updated_by)
     VALUES ('stars_monitor_target_limit', '3', ?, 'migration')`,
  ).run(now);

  db.prepare(
    `UPDATE star_result_bundles
     SET user_id = CAST(json_extract(task_json, '$.user.id') AS TEXT)
     WHERE status = 'OFFERED'
       AND json_extract(task_json, '$.user.id') IS NOT NULL
       AND user_id <> CAST(json_extract(task_json, '$.user.id') AS TEXT)`,
  ).run();

  db.prepare(
    'DELETE FROM star_monitor_delete_authorizations WHERE authorized_at < ?',
  ).run(now - 300);
}

function migrateDefaultPaymentMode(): void {
  const now = nowSeconds();
  const modeRow = db.prepare(
    `SELECT value, updated_by FROM bot_settings WHERE key = 'payment_mode'`,
  ).get() as { value?: string; updated_by?: string | null } | undefined;

  const activeInvoice = db.prepare(
    `SELECT COUNT(*) AS count
     FROM payments
     WHERE paid_at IS NULL
       AND COALESCE(expires_at, 0) >= ?`,
  ).get(now) as { count?: number } | undefined;
  const activeCheck = db.prepare(
    'SELECT COUNT(*) AS count FROM payment_checks',
  ).get() as { count?: number } | undefined;
  const hasActiveLegacyPayment =
    Number(activeInvoice?.count ?? 0) > 0 || Number(activeCheck?.count ?? 0) > 0;

  const wasAutomatic = !modeRow || modeRow.updated_by === 'migration';
  if (!wasAutomatic) return;

  setSetting(
    'payment_mode',
    hasActiveLegacyPayment ? 'btc' : 'stars',
    'migration',
  );
}

export function getStarsMonitorPrice(plan: 'week' | 'month'): number {
  const key = plan === 'week' ? 'stars_monitor_week_price' : 'stars_monitor_month_price';
  const fallback = plan === 'week' ? 199 : 499;
  const value = Number(getSetting(key));
  return Number.isInteger(value) && value > 0 && value <= 10_000 ? value : fallback;
}

export function getStarsMonitorTargetLimit(): number {
  const value = Number(getSetting('stars_monitor_target_limit'));
  return Number.isInteger(value) && value > 0 && value <= 20 ? value : 3;
}

export function getStarsMonitoringEntitlement(userId: string):
  | { expiresAt: number; maxTargets: number; plan: string }
  | undefined {
  const row = db.prepare(
    `SELECT expires_at, max_targets, plan
     FROM star_monitor_entitlements
     WHERE user_id = ? AND expires_at > ?`,
  ).get(userId, nowSeconds()) as
    | { expires_at: number; max_targets: number; plan: string }
    | undefined;
  if (!row) return undefined;
  return {
    expiresAt: Number(row.expires_at),
    maxTargets: Number(row.max_targets),
    plan: row.plan,
  };
}

export function authorizeStarsMonitorRemoval(
  telegramId: string,
  targetId: string,
): void {
  db.prepare(
    `INSERT INTO star_monitor_delete_authorizations (
       telegram_id, target_id, authorized_at
     ) VALUES (?, ?, ?)
     ON CONFLICT(telegram_id, target_id) DO UPDATE SET
       authorized_at = excluded.authorized_at`,
  ).run(telegramId, targetId, nowSeconds());
}

export function clearStarsMonitorRemovalAuthorization(
  telegramId: string,
  targetId: string,
): void {
  db.prepare(
    `DELETE FROM star_monitor_delete_authorizations
     WHERE telegram_id = ? AND target_id = ?`,
  ).run(telegramId, targetId);
}

async function runStarsMonitorCycle(): Promise<void> {
  if (monitorCycleRunning) return;
  monitorCycleRunning = true;
  try {
    const now = nowSeconds();
    const rows = db.prepare(
      `SELECT m.id
       FROM monitors m
       JOIN star_monitor_entitlements e ON e.user_id = m.telegram_id
       LEFT JOIN users u ON u.telegram_id = m.telegram_id
       WHERE e.expires_at > ?
         AND NOT (
           COALESCE(u.is_premium, 0) = 1
           AND (u.premium_until IS NULL OR u.premium_until >= ?)
         )
       ORDER BY m.id`,
    ).all(now, now) as { id: number }[];

    if (!rows.length) return;
    const { checkSingleMonitor } = await import('./monitor-service');
    for (const row of rows) {
      await checkSingleMonitor(Number(row.id));
    }
  } catch (error) {
    console.error('[StarsMonitor] Scheduled check failed:', error);
  } finally {
    monitorCycleRunning = false;
  }
}

function startStarsMonitorLoop(): void {
  if (monitorTimer) return;
  const initial = setTimeout(() => {
    void runStarsMonitorCycle();
  }, 30_000);
  initial.unref?.();
  monitorTimer = setInterval(() => {
    void runStarsMonitorCycle();
  }, MONITOR_INTERVAL_MS);
  monitorTimer.unref?.();
}

function retainPendingTelegramUpdates(bot: Telegraf<IContextBot>): void {
  if (launchPatched) return;
  launchPatched = true;
  const originalLaunch = bot.launch.bind(bot);
  (bot as any).launch = (config: Record<string, unknown> = {}) =>
    originalLaunch({ ...config, dropPendingUpdates: false });
}

export function initializeStarsModeSafety(bot: Telegraf<IContextBot>): void {
  initializeSafetySchema();
  migrateDefaultPaymentMode();
  retainPendingTelegramUpdates(bot);
  startStarsMonitorLoop();
}
