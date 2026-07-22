import { randomUUID } from 'crypto';
import type { Telegraf } from 'telegraf';
import { db } from 'db';
import { enqueueDownloadFx } from 'db/effects';
import { BOT_ADMIN_ID, BTC_CONFIGURED } from 'config/env-config';
import { IContextBot } from 'config/context-interface';
import { t } from 'lib/i18n';
import { SendStoriesFxParams, UserInfo } from 'types';

export type PaymentMode = 'stars' | 'btc';

type BundleStatus =
  | 'OFFERED'
  | 'PAID'
  | 'DELIVERING'
  | 'DELIVERED'
  | 'REFUND_PENDING'
  | 'REFUNDED';

interface StarsBundleRow {
  id: string;
  user_id: string;
  chat_id: string;
  target: string;
  locale: string;
  request_kind: string;
  story_ids: string;
  task_json: string;
  result_count: number;
  price_stars: number;
  status: BundleStatus;
  created_at: number;
  expires_at: number;
  paid_at?: number | null;
  delivered_at?: number | null;
  refunded_at?: number | null;
  attempt_count: number;
  last_attempt_at?: number | null;
  last_error?: string | null;
}

interface StarsPaymentRow {
  telegram_payment_charge_id: string;
  provider_payment_charge_id?: string | null;
  bundle_id: string;
  user_id: string;
  amount_stars: number;
  paid_at: number;
  refunded_at?: number | null;
}

const DEFAULT_PRICE_STARS = 25;
const DEFAULT_BUNDLE_TTL_MINUTES = 30;
const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_STALE_SECONDS = 12 * 60;
const RECOVERY_INTERVAL_MS = 60 * 1000;

let botInstance: Telegraf<IContextBot> | null = null;
let registered = false;
let recoveryTimer: NodeJS.Timeout | null = null;
let recoveryRunning = false;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function initializeSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS star_result_bundles (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      target TEXT NOT NULL,
      locale TEXT NOT NULL,
      request_kind TEXT NOT NULL,
      story_ids TEXT NOT NULL,
      task_json TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      price_stars INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OFFERED',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      paid_at INTEGER,
      delivered_at INTEGER,
      refunded_at INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS star_result_bundles_user_idx
      ON star_result_bundles (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS star_result_bundles_recovery_idx
      ON star_result_bundles (status, last_attempt_at);

    CREATE TABLE IF NOT EXISTS star_payments (
      telegram_payment_charge_id TEXT PRIMARY KEY NOT NULL,
      provider_payment_charge_id TEXT,
      bundle_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      amount_stars INTEGER NOT NULL,
      paid_at INTEGER NOT NULL,
      refunded_at INTEGER,
      FOREIGN KEY (bundle_id) REFERENCES star_result_bundles(id)
    );

    CREATE INDEX IF NOT EXISTS star_payments_user_idx
      ON star_payments (user_id, paid_at DESC);
  `);

  const now = nowSeconds();
  db.prepare(
    `INSERT OR IGNORE INTO bot_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)`,
  ).run('stars_enabled', '1', now, 'migration');
  db.prepare(
    `INSERT OR IGNORE INTO bot_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)`,
  ).run('stars_result_price', String(DEFAULT_PRICE_STARS), now, 'migration');
  db.prepare(
    `INSERT OR IGNORE INTO bot_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)`,
  ).run('stars_bundle_ttl_minutes', String(DEFAULT_BUNDLE_TTL_MINUTES), now, 'migration');

  const existingMode = getSetting('payment_mode');
  if (!existingMode) {
    const paidBtc = db
      .prepare('SELECT COUNT(*) AS count FROM payments WHERE paid_at IS NOT NULL')
      .get() as { count?: number } | undefined;
    // Existing installations with no completed BTC payments move to Stars
    // automatically, even if a wallet was previously required only to boot.
    const mode: PaymentMode = BTC_CONFIGURED && Number(paidBtc?.count ?? 0) > 0
      ? 'btc'
      : 'stars';
    setSetting('payment_mode', mode, 'migration');
  }
}

function getSetting(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM bot_settings WHERE key = ?')
    .get(key) as { value?: string } | undefined;
  return row?.value;
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

function getIntSetting(key: string, fallback: number): number {
  const value = Number(getSetting(key));
  return Number.isInteger(value) ? value : fallback;
}

initializeSchema();

export function getPaymentMode(): PaymentMode {
  return getSetting('payment_mode') === 'btc' ? 'btc' : 'stars';
}

export function isStarsMode(): boolean {
  return getPaymentMode() === 'stars';
}

export function setPaymentMode(mode: PaymentMode, changedBy: string): boolean {
  if (mode === 'btc' && !BTC_CONFIGURED) return false;
  setSetting('payment_mode', mode, changedBy);
  return true;
}

export function areStarsEnabled(): boolean {
  return getSetting('stars_enabled') !== '0';
}

export function getStarsPrice(): number {
  return Math.max(1, Math.min(10_000, getIntSetting('stars_result_price', DEFAULT_PRICE_STARS)));
}

export function getBundleTtlMinutes(): number {
  return Math.max(5, Math.min(240, getIntSetting('stars_bundle_ttl_minutes', DEFAULT_BUNDLE_TTL_MINUTES)));
}

function getBundle(id: string): StarsBundleRow | undefined {
  return db
    .prepare('SELECT * FROM star_result_bundles WHERE id = ?')
    .get(id) as StarsBundleRow | undefined;
}

export function isStarsBundleDeliverable(bundleId: string): boolean {
  const bundle = getBundle(bundleId);
  return Boolean(
    bundle &&
    bundle.status === 'DELIVERING' &&
    !bundle.refunded_at
  );
}

function getPaymentForBundle(bundleId: string): StarsPaymentRow | undefined {
  return db
    .prepare('SELECT * FROM star_payments WHERE bundle_id = ?')
    .get(bundleId) as StarsPaymentRow | undefined;
}

function getLatestPaymentForUser(userId: string): (StarsPaymentRow & { status: BundleStatus; delivered_at?: number; bundle_refunded_at?: number }) | undefined {
  return db.prepare(
    `SELECT p.*, b.status, b.delivered_at, b.refunded_at AS bundle_refunded_at
     FROM star_payments p
     JOIN star_result_bundles b ON b.id = p.bundle_id
     WHERE p.user_id = ?
     ORDER BY p.paid_at DESC
     LIMIT 1`,
  ).get(userId) as (StarsPaymentRow & { status: BundleStatus; delivered_at?: number; bundle_refunded_at?: number }) | undefined;
}

function collectResultIds(params: SendStoriesFxParams): number[] {
  const ids = new Set<number>();
  for (const story of params.activeStories ?? []) ids.add(story.id);
  for (const story of params.pinnedStories ?? []) ids.add(story.id);
  if (params.particularStory) ids.add(params.particularStory.id);
  return [...ids];
}

function isPayableRequest(params: SendStoriesFxParams): boolean {
  const { task } = params;
  if (!isStarsMode() || !areStarsEnabled()) return false;
  if (task.starsUnlocked || task.isPremium) return false;
  if (task.chatId === String(BOT_ADMIN_ID)) return false;
  if (task.storyRequestType === 'archived' || task.storyRequestType === 'global' || task.storyRequestType === 'paginated') {
    return false;
  }
  if ((params.archivedStories?.length ?? 0) > 0 || (params.globalStories?.length ?? 0) > 0 || (params.paginatedStories?.length ?? 0) > 0) {
    return false;
  }
  return collectResultIds(params).length > 0;
}

function createBundle(params: SendStoriesFxParams, storyIds: number[]): StarsBundleRow {
  const now = nowSeconds();
  const task: UserInfo = {
    ...params.task,
    instanceId: undefined,
    tempMessages: undefined,
    starsUnlocked: undefined,
    starsBundleId: undefined,
    starsPaymentChargeId: undefined,
    starsExpectedStoryIds: undefined,
  };
  const id = randomUUID();
  const price = getStarsPrice();
  const expiresAt = now + getBundleTtlMinutes() * 60;
  const requestKind = params.particularStory ? 'particular' : 'current';

  db.prepare(
    `INSERT INTO star_result_bundles (
       id, user_id, chat_id, target, locale, request_kind, story_ids,
       task_json, result_count, price_stars, status, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OFFERED', ?, ?)`,
  ).run(
    id,
    task.chatId,
    task.chatId,
    task.link,
    task.locale || 'en',
    requestKind,
    JSON.stringify(storyIds),
    JSON.stringify(task),
    storyIds.length,
    price,
    now,
    expiresAt,
  );

  return getBundle(id)!;
}

async function callBotApi<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
  if (!botInstance) throw new Error('Stars payment service has no bot instance');
  return (botInstance.telegram as any).callApi(method, payload) as Promise<T>;
}

export async function maybeOfferStoryUnlock(params: SendStoriesFxParams): Promise<boolean> {
  if (!isPayableRequest(params)) return false;
  if (!botInstance) throw new Error('Stars payment service has not been registered');

  const storyIds = collectResultIds(params);
  const bundle = createBundle(params, storyIds);
  const plural = bundle.result_count === 1 ? '' : 's';

  await botInstance.telegram.sendMessage(
    bundle.chat_id,
    t(bundle.locale, 'stars.resultsFound', {
      count: bundle.result_count,
      plural,
      target: bundle.target,
      price: bundle.price_stars,
    }),
    { link_preview_options: { is_disabled: true } },
  );

  await callBotApi('sendInvoice', {
    chat_id: bundle.chat_id,
    title: t(bundle.locale, 'stars.invoiceTitle'),
    description: t(bundle.locale, 'stars.invoiceDescription', {
      count: bundle.result_count,
      plural,
      target: bundle.target,
    }),
    payload: bundle.id,
    currency: 'XTR',
    prices: [
      {
        label: t(bundle.locale, 'stars.invoiceLabel', {
          count: bundle.result_count,
          plural,
        }),
        amount: bundle.price_stars,
      },
    ],
    start_parameter: `unlock_${bundle.id.replace(/-/g, '')}`,
  });

  return true;
}

function validateCheckout(query: any): { ok: true; bundle: StarsBundleRow } | { ok: false; locale: string } {
  const bundle = getBundle(String(query.invoice_payload ?? ''));
  const locale = bundle?.locale || query.from?.language_code || 'en';
  const valid = Boolean(
    bundle &&
    isStarsMode() &&
    areStarsEnabled() &&
    bundle.status === 'OFFERED' &&
    bundle.expires_at >= nowSeconds() &&
    bundle.user_id === String(query.from?.id) &&
    query.currency === 'XTR' &&
    Number(query.total_amount) === bundle.price_stars,
  );
  return valid ? { ok: true, bundle: bundle! } : { ok: false, locale };
}

async function enqueuePaidBundle(bundle: StarsBundleRow, chargeId: string, force = false): Promise<void> {
  const currentBundle = getBundle(bundle.id);
  if (!currentBundle) return;
  if (!force && currentBundle.status === 'DELIVERED') return;
  if (currentBundle.status === 'DELIVERED' || currentBundle.status === 'REFUND_PENDING' || currentBundle.status === 'REFUNDED') return;
  const originalTask = JSON.parse(currentBundle.task_json) as UserInfo;
  const storyIds = JSON.parse(currentBundle.story_ids) as number[];
  const paidTask: UserInfo = {
    ...originalTask,
    chatId: currentBundle.chat_id,
    initTime: Date.now(),
    starsUnlocked: true,
    starsBundleId: currentBundle.id,
    starsPaymentChargeId: chargeId,
    starsExpectedStoryIds: storyIds,
  };

  const now = nowSeconds();
  const updated = db.prepare(
    `UPDATE star_result_bundles
     SET status = 'DELIVERING',
         attempt_count = attempt_count + 1,
         last_attempt_at = ?,
         last_error = NULL
     WHERE id = ? AND status IN ('PAID', 'DELIVERING')`,
  ).run(now, currentBundle.id);
  if (updated.changes === 0) return;

  try {
    await enqueueDownloadFx({
      telegram_id: currentBundle.user_id,
      target_username: originalTask.link,
      task_details: paidTask,
      delaySeconds: 0,
    });
    const { processQueue } = await import('./queue-manager');
    setImmediate(processQueue);
  } catch (error: any) {
    db.prepare(
      `UPDATE star_result_bundles
       SET status = 'PAID', last_error = ?
       WHERE id = ? AND status IN ('PAID', 'DELIVERING')`,
    ).run(error?.message || String(error), currentBundle.id);
    throw error;
  }
}

async function recordSuccessfulPayment(ctx: any, payment: any): Promise<void> {
  const chargeId = String(payment.telegram_payment_charge_id ?? '');
  const providerChargeId = payment.provider_payment_charge_id
    ? String(payment.provider_payment_charge_id)
    : null;
  const bundle = getBundle(String(payment.invoice_payload ?? ''));
  const userId = String(ctx.from?.id ?? '');
  const locale = bundle?.locale || ctx.from?.language_code || 'en';

  if (!chargeId || !bundle || bundle.user_id !== userId || payment.currency !== 'XTR' || Number(payment.total_amount) !== bundle.price_stars) {
    throw new Error('Successful Stars payment did not match a valid result bundle');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO star_payments (
         telegram_payment_charge_id, provider_payment_charge_id, bundle_id,
         user_id, amount_stars, paid_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(chargeId, providerChargeId, bundle.id, userId, bundle.price_stars, nowSeconds());

    if (inserted.changes > 0) {
      db.prepare(
        `UPDATE star_result_bundles
         SET status = 'PAID', paid_at = ?, last_error = NULL
         WHERE id = ? AND status NOT IN ('DELIVERED', 'REFUNDED')`,
      ).run(nowSeconds(), bundle.id);
    }
    db.exec('COMMIT');

    const current = getBundle(bundle.id)!;
    if (inserted.changes === 0) {
      await ctx.reply(t(locale, 'stars.paymentDuplicate'));
      if (current.status !== 'DELIVERED' && current.status !== 'REFUNDED') {
        await enqueuePaidBundle(current, chargeId, true);
      }
      return;
    }

    await ctx.reply(t(locale, 'stars.paymentReceived'));
    await enqueuePaidBundle(current, chargeId);
    if (botInstance && userId !== String(BOT_ADMIN_ID)) {
      await botInstance.telegram.sendMessage(
        BOT_ADMIN_ID,
        `⭐ Stars purchase: ${bundle.price_stars} Stars, ${bundle.result_count} results, ${bundle.target}, user ${userId}`,
      ).catch(() => {});
    }
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function markStarsBundleDelivered(bundleId: string): void {
  db.prepare(
    `UPDATE star_result_bundles
     SET status = 'DELIVERED', delivered_at = ?, last_error = NULL
     WHERE id = ? AND status = 'DELIVERING'`,
  ).run(nowSeconds(), bundleId);
}

export function recordStarsDeliveryFailure(bundleId: string, error: unknown): void {
  db.prepare(
    `UPDATE star_result_bundles
     SET status = 'PAID', last_error = ?
     WHERE id = ? AND status IN ('PAID', 'DELIVERING')`,
  ).run(error instanceof Error ? error.message : String(error), bundleId);
}

async function refundBundle(
  bundle: StarsBundleRow,
  notifyUser = true,
  deferIfProcessing = false,
): Promise<boolean> {
  const payment = getPaymentForBundle(bundle.id);
  if (!payment || payment.refunded_at || bundle.status === 'REFUNDED') return Boolean(payment?.refunded_at);
  if (!botInstance) return false;

  db.exec('BEGIN IMMEDIATE');
  try {
    const processing = db.prepare(
      `SELECT 1
       FROM download_queue
       WHERE status = 'processing'
         AND json_extract(task_details, '$.starsBundleId') = ?
       LIMIT 1`,
    ).get(bundle.id);
    if (processing) {
      if (deferIfProcessing) {
        db.prepare(
          `UPDATE star_result_bundles
           SET status = 'REFUND_PENDING'
           WHERE id = ?
             AND (
               status IN ('PAID', 'DELIVERING', 'REFUND_PENDING')
               OR (status = 'DELIVERED' AND request_kind IN ('monitor_week', 'monitor_month'))
             )`,
        ).run(bundle.id);
        db.exec('COMMIT');
      } else {
        db.exec('ROLLBACK');
      }
      return false;
    }

    db.prepare(
      `DELETE FROM download_queue
       WHERE status = 'pending'
         AND json_extract(task_details, '$.starsBundleId') = ?`,
    ).run(bundle.id);

    const fenced = db.prepare(
      `UPDATE star_result_bundles
       SET status = 'REFUND_PENDING', last_error = NULL
       WHERE id = ? AND status IN ('PAID', 'DELIVERING', 'REFUND_PENDING')`,
    ).run(bundle.id);
    if (fenced.changes === 0) {
      db.exec('ROLLBACK');
      return false;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }

  try {
    await callBotApi('refundStarPayment', {
      user_id: Number(bundle.user_id),
      telegram_payment_charge_id: payment.telegram_payment_charge_id,
    });
    const now = nowSeconds();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE star_payments SET refunded_at = ? WHERE telegram_payment_charge_id = ?')
        .run(now, payment.telegram_payment_charge_id);
      db.prepare(
        `UPDATE star_result_bundles
         SET status = 'REFUNDED', refunded_at = ?, last_error = NULL
         WHERE id = ?`,
      ).run(now, bundle.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (notifyUser) {
      await botInstance.telegram.sendMessage(
        bundle.chat_id,
        t(bundle.locale, 'stars.refundedUnavailable', { amount: bundle.price_stars }),
      ).catch(() => {});
    }
    return true;
  } catch (error: any) {
    db.prepare(
      `UPDATE star_result_bundles
       SET status = 'REFUND_PENDING', last_error = ?
       WHERE id = ?`,
    ).run(error?.message || String(error), bundle.id);
    if (notifyUser) {
      await botInstance.telegram.sendMessage(bundle.chat_id, t(bundle.locale, 'stars.refundPending')).catch(() => {});
    }
    return false;
  }
}

export async function refundUndeliverableStarsBundle(bundleId: string): Promise<boolean> {
  const bundle = getBundle(bundleId);
  if (!bundle) return false;
  return refundBundle(bundle, true, true);
}

export async function finalizeDeferredStarsRefund(bundleId: string): Promise<boolean> {
  const bundle = getBundle(bundleId);
  if (!bundle || bundle.status !== 'REFUND_PENDING') return false;
  return refundBundle(bundle);
}

export async function recoverPaidBundles(): Promise<void> {
  if (recoveryRunning || !botInstance) return;
  recoveryRunning = true;
  try {
    const cutoff = nowSeconds() - DELIVERY_STALE_SECONDS;
    const rows = db.prepare(
      `SELECT * FROM star_result_bundles
       WHERE status IN ('PAID', 'DELIVERING', 'REFUND_PENDING')
         AND delivered_at IS NULL
         AND refunded_at IS NULL
         AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
       ORDER BY paid_at ASC
       LIMIT 20`,
    ).all(cutoff) as StarsBundleRow[];

    for (const bundle of rows) {
      if (bundle.status === 'REFUND_PENDING' || bundle.attempt_count >= MAX_DELIVERY_ATTEMPTS) {
        await refundBundle(bundle);
        continue;
      }
      const payment = getPaymentForBundle(bundle.id);
      if (!payment) continue;
      await enqueuePaidBundle(bundle, payment.telegram_payment_charge_id, true).catch(() => {});
    }

    db.prepare(
      `DELETE FROM star_result_bundles
       WHERE status = 'OFFERED' AND expires_at < ?`,
    ).run(nowSeconds() - 24 * 60 * 60);
  } finally {
    recoveryRunning = false;
  }
}

function formatDate(epoch?: number | null): string {
  if (!epoch) return '-';
  return new Date(epoch * 1000).toLocaleString();
}

function getAdminStats(): Record<string, number> {
  const today = nowSeconds() - 24 * 60 * 60;
  const todayRow = db.prepare(
    `SELECT COUNT(*) AS purchases, COALESCE(SUM(amount_stars), 0) AS stars
     FROM star_payments WHERE paid_at >= ? AND refunded_at IS NULL`,
  ).get(today) as { purchases?: number; stars?: number };
  const allRow = db.prepare(
    `SELECT COUNT(*) AS purchases, COALESCE(SUM(amount_stars), 0) AS stars
     FROM star_payments WHERE refunded_at IS NULL`,
  ).get() as { purchases?: number; stars?: number };
  const bundleRow = db.prepare(
    `SELECT
       SUM(CASE WHEN status IN ('PAID', 'DELIVERING') THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'REFUND_PENDING' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'REFUNDED' THEN 1 ELSE 0 END) AS refunded
     FROM star_result_bundles`,
  ).get() as { pending?: number; failed?: number; refunded?: number };
  return {
    todayPurchases: Number(todayRow?.purchases ?? 0),
    todayStars: Number(todayRow?.stars ?? 0),
    allPurchases: Number(allRow?.purchases ?? 0),
    allStars: Number(allRow?.stars ?? 0),
    pending: Number(bundleRow?.pending ?? 0),
    failed: Number(bundleRow?.failed ?? 0),
    refunded: Number(bundleRow?.refunded ?? 0),
  };
}

function adminPanel(locale: string): { text: string; reply_markup: any } {
  const price = getStarsPrice();
  const enabled = areStarsEnabled();
  const mode = getPaymentMode();
  const stats = getAdminStats();
  const text = t(locale, 'stars.adminPanel', {
    mode: t(locale, mode === 'stars' ? 'stars.adminModeStars' : 'stars.adminModeBtc'),
    status: t(locale, enabled ? 'stars.adminEnabled' : 'stars.adminDisabled'),
    price,
    ttl: getBundleTtlMinutes(),
    ...stats,
  });
  const keyboard: any[][] = [
    [
      { text: '−10', callback_data: 'starsadmin:price:-10' },
      { text: '−5', callback_data: 'starsadmin:price:-5' },
      { text: `⭐${price}`, callback_data: 'starsadmin:refresh' },
      { text: '+5', callback_data: 'starsadmin:price:5' },
      { text: '+10', callback_data: 'starsadmin:price:10' },
    ],
    [
      { text: enabled ? 'Pause Stars' : 'Enable Stars', callback_data: 'starsadmin:toggle' },
      { text: 'Refresh', callback_data: 'starsadmin:refresh' },
    ],
  ];
  if (BTC_CONFIGURED) {
    keyboard.push([
      {
        text: mode === 'stars' ? 'Use legacy BTC' : 'Use Telegram Stars',
        callback_data: `starsadmin:mode:${mode === 'stars' ? 'btc' : 'stars'}`,
      },
    ]);
  }
  return { text, reply_markup: { inline_keyboard: keyboard } };
}

async function handlePaySupport(ctx: any): Promise<void> {
  const userId = String(ctx.from?.id ?? '');
  const locale = ctx.from?.language_code || 'en';
  const latest = getLatestPaymentForUser(userId);
  if (!latest) return ctx.reply(t(locale, 'stars.supportNone'));

  if (latest.status === 'DELIVERED') {
    return ctx.reply(t(locale, 'stars.supportDelivered', { date: formatDate(latest.delivered_at) }));
  }
  if (latest.status === 'REFUNDED' || latest.refunded_at || latest.bundle_refunded_at) {
    return ctx.reply(t(locale, 'stars.supportRefunded', { date: formatDate(latest.refunded_at || latest.bundle_refunded_at) }));
  }
  if (latest.status === 'PAID' || latest.status === 'DELIVERING') {
    const bundle = getBundle(latest.bundle_id);
    if (bundle) await enqueuePaidBundle(bundle, latest.telegram_payment_charge_id, true).catch(() => {});
    return ctx.reply(t(locale, 'stars.supportPending'));
  }
  await botInstance?.telegram.sendMessage(BOT_ADMIN_ID, `Stars support review needed for user ${userId}, charge ${latest.telegram_payment_charge_id}`).catch(() => {});
  return ctx.reply(t(locale, 'stars.supportUnknown'));
}

export function registerStarsPayments(bot: Telegraf<IContextBot>): void {
  botInstance = bot;
  if (registered) return;
  registered = true;

  bot.on('pre_checkout_query', async (ctx: any) => {
    const result = validateCheckout(ctx.preCheckoutQuery);
    if (result.ok) {
      await ctx.answerPreCheckoutQuery(true);
    } else {
      await ctx.answerPreCheckoutQuery(false, t(result.locale, 'stars.invoiceExpired'));
    }
  });

  bot.on('message', async (ctx: any, next: () => Promise<void>) => {
    const payment = ctx.message?.successful_payment;
    if (!payment) return next();
    try {
      await recordSuccessfulPayment(ctx, payment);
    } catch (error) {
      console.error('[Stars] Failed to process successful payment:', error);
      await bot.telegram.sendMessage(BOT_ADMIN_ID, `Stars payment processing failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
      throw error;
    }
  });

  bot.command('paysupport', handlePaySupport);
  bot.command('terms', async (ctx) => {
    await ctx.reply(t(ctx.from?.language_code, 'stars.termsText'), { parse_mode: 'Markdown' });
  });

  bot.command('starsadmin', async (ctx) => {
    if (ctx.from?.id !== BOT_ADMIN_ID) return;
    const panel = adminPanel(ctx.from?.language_code || 'en');
    await ctx.reply(panel.text, { parse_mode: 'Markdown', reply_markup: panel.reply_markup });
  });

  bot.command('setstarsprice', async (ctx: any) => {
    if (ctx.from?.id !== BOT_ADMIN_ID) return;
    const locale = ctx.from?.language_code || 'en';
    const value = Number(String(ctx.message?.text || '').split(/\s+/)[1]);
    if (!Number.isInteger(value) || value < 1 || value > 10_000) {
      return ctx.reply(t(locale, 'stars.adminInvalidPrice'));
    }
    const old = getStarsPrice();
    setSetting('stars_result_price', String(value), String(ctx.from.id));
    return ctx.reply(t(locale, 'stars.adminPriceChanged', { old, price: value }));
  });

  bot.command('refundstars', async (ctx: any) => {
    if (ctx.from?.id !== BOT_ADMIN_ID) return;
    const locale = ctx.from?.language_code || 'en';
    const chargeId = String(ctx.message?.text || '').split(/\s+/)[1];
    const payment = chargeId
      ? db.prepare('SELECT * FROM star_payments WHERE telegram_payment_charge_id = ?').get(chargeId) as StarsPaymentRow | undefined
      : undefined;
    const bundle = payment ? getBundle(payment.bundle_id) : undefined;
    if (!bundle || !payment || payment.refunded_at) return ctx.reply(t(locale, 'stars.manualRefundNotFound'));
    const refunded = await refundBundle(bundle, false);
    return ctx.reply(t(locale, refunded ? 'stars.manualRefundSuccess' : 'stars.refundFailed'));
  });

  bot.action(/^starsadmin:(.+)$/, async (ctx: any) => {
    if (ctx.from?.id !== BOT_ADMIN_ID) return ctx.answerCbQuery();
    const locale = ctx.from?.language_code || 'en';
    const action = String(ctx.match?.[1] || 'refresh');
    if (action === 'toggle') {
      const enabled = !areStarsEnabled();
      setSetting('stars_enabled', enabled ? '1' : '0', String(ctx.from.id));
      await ctx.answerCbQuery(t(locale, 'stars.adminToggled', {
        status: t(locale, enabled ? 'stars.adminEnabled' : 'stars.adminDisabled'),
      }));
    } else if (action.startsWith('price:')) {
      const delta = Number(action.slice('price:'.length));
      const old = getStarsPrice();
      const price = Math.max(1, Math.min(10_000, old + delta));
      setSetting('stars_result_price', String(price), String(ctx.from.id));
      await ctx.answerCbQuery(t(locale, 'stars.adminPriceChanged', { old, price }));
    } else if (action.startsWith('mode:')) {
      const mode = action.slice('mode:'.length) === 'btc' ? 'btc' : 'stars';
      const changed = setPaymentMode(mode, String(ctx.from.id));
      if (changed) {
        const { synchronizeLegacyCommandMenus, synchronizeStarsCommandMenus } =
          await import('./stars-command-surface');
        if (mode === 'stars') {
          await synchronizeStarsCommandMenus(bot, true);
        } else {
          await synchronizeLegacyCommandMenus(bot);
        }
      }
      await ctx.answerCbQuery(
        changed
          ? t(locale, 'stars.adminModeChanged', { mode: t(locale, mode === 'stars' ? 'stars.adminModeStars' : 'stars.adminModeBtc') })
          : t(locale, 'stars.adminBtcUnavailable'),
      );
    } else {
      await ctx.answerCbQuery();
    }
    const panel = adminPanel(locale);
    await ctx.editMessageText(panel.text, { parse_mode: 'Markdown', reply_markup: panel.reply_markup });
  });

  recoveryTimer = setInterval(() => {
    recoverPaidBundles().catch((error) => console.error('[Stars] Recovery loop failed:', error));
  }, RECOVERY_INTERVAL_MS);
  recoveryTimer.unref?.();
  setImmediate(() => recoverPaidBundles().catch((error) => console.error('[Stars] Initial recovery failed:', error)));
}
