import { randomUUID } from 'crypto';
import type { Telegraf } from 'telegraf';
import { BOT_ADMIN_ID } from 'config/env-config';
import { IContextBot } from 'config/context-interface';
import { db } from 'db';
import { t } from 'lib/i18n';
import { saveUser } from '../repositories/user-repository';
import { isUserPremium } from './premium-service';
import {
  addProfileMonitor,
  formatMonitorTarget,
  listUserMonitors,
  refreshMonitorUsername,
  removeProfileMonitor,
  userMonitorCount,
} from './monitor-service';
import {
  areStarsEnabled,
  getBundleTtlMinutes,
  getStarsPrice,
  isStarsMode,
} from './stars-payment';
import {
  authorizeStarsMonitorRemoval,
  clearStarsMonitorRemovalAuthorization,
  getStarsMonitoringEntitlement,
  getStarsMonitorPrice,
  getStarsMonitorTargetLimit,
  initializeStarsModeSafety,
  setStarsMonitorPrice,
} from './stars-mode-safety';

const COMMAND_SCOPE_MIGRATION_KEY = 'stars_command_scope_v4';
const syncedChats = new Set<string>();
let registered = false;

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_command_scopes (
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'en',
    is_group INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
`);

function getStarsBaseCommands(locale: string) {
  return [
    { command: 'start', description: t(locale, 'cmd.start') },
    { command: 'help', description: t(locale, 'cmd.help') },
    { command: 'monitor', description: t(locale, 'cmd.monitor') },
    { command: 'unmonitor', description: t(locale, 'cmd.unmonitor') },
    { command: 'queue', description: t(locale, 'cmd.queue') },
    { command: 'profile', description: t(locale, 'cmd.profile') },
    { command: 'bugs', description: t(locale, 'cmd.bugs') },
    { command: 'paysupport', description: t(locale, 'cmd.paysupport') },
    { command: 'terms', description: t(locale, 'cmd.terms') },
  ];
}

function getPremiumCommands(locale: string) {
  return [{ command: 'archive', description: t(locale, 'cmd.archive') }];
}

function getAdminCommands(locale: string) {
  return [
    { command: 'starsadmin', description: t(locale, 'cmd.starsadmin') },
    { command: 'setstarsprice', description: 'Set the Stars result price' },
    { command: 'setmonitorprice', description: 'Set week/month monitoring price' },
    { command: 'refundstars', description: 'Refund a Stars charge' },
    { command: 'setpremium', description: t(locale, 'cmd.setpremium') },
    { command: 'unsetpremium', description: t(locale, 'cmd.unsetpremium') },
    { command: 'ispremium', description: t(locale, 'cmd.ispremium') },
    { command: 'listpremium', description: t(locale, 'cmd.listpremium') },
    { command: 'users', description: t(locale, 'cmd.users') },
    { command: 'history', description: t(locale, 'cmd.history') },
    { command: 'block', description: t(locale, 'cmd.block') },
    { command: 'unblock', description: t(locale, 'cmd.unblock') },
    { command: 'blocklist', description: t(locale, 'cmd.blocklist') },
    { command: 'status', description: t(locale, 'cmd.status') },
    { command: 'restart', description: t(locale, 'cmd.restart') },
    { command: 'flush', description: t(locale, 'cmd.flush') },
    { command: 'forcemonitor', description: t(locale, 'cmd.forcemonitor') },
    { command: 'stopmonitor', description: t(locale, 'cmd.stopmonitor') },
    { command: 'globalstories', description: t(locale, 'cmd.globalstories') },
    { command: 'welcome', description: t(locale, 'cmd.welcome') },
    { command: 'bugreport', description: t(locale, 'cmd.listbugs') },
  ];
}

function getLegacyBaseCommands(locale: string) {
  return [
    { command: 'start', description: t(locale, 'cmd.start') },
    { command: 'help', description: t(locale, 'cmd.help') },
    { command: 'premium', description: t(locale, 'cmd.premium') },
    { command: 'upgrade', description: t(locale, 'cmd.upgrade') },
    { command: 'freetrial', description: t(locale, 'cmd.freetrial') },
    { command: 'verify', description: t(locale, 'cmd.verify') },
    { command: 'queue', description: t(locale, 'cmd.queue') },
    { command: 'invite', description: t(locale, 'cmd.invite') },
    { command: 'profile', description: t(locale, 'cmd.profile') },
    { command: 'bugs', description: t(locale, 'cmd.bugs') },
  ];
}

function getLegacyMonitoringCommands(locale: string) {
  return [
    { command: 'monitor', description: t(locale, 'cmd.monitor') },
    { command: 'unmonitor', description: t(locale, 'cmd.unmonitor') },
  ];
}

function getLegacyPremiumCommands(locale: string) {
  return [{ command: 'archive', description: t(locale, 'cmd.archive') }];
}

function getLegacyAdminCommands(locale: string) {
  return [
    { command: 'setpremium', description: t(locale, 'cmd.setpremium') },
    { command: 'unsetpremium', description: t(locale, 'cmd.unsetpremium') },
    { command: 'ispremium', description: t(locale, 'cmd.ispremium') },
    { command: 'listpremium', description: t(locale, 'cmd.listpremium') },
    { command: 'users', description: t(locale, 'cmd.users') },
    { command: 'history', description: t(locale, 'cmd.history') },
    { command: 'block', description: t(locale, 'cmd.block') },
    { command: 'unblock', description: t(locale, 'cmd.unblock') },
    { command: 'blocklist', description: t(locale, 'cmd.blocklist') },
    { command: 'status', description: t(locale, 'cmd.status') },
    { command: 'restart', description: t(locale, 'cmd.restart') },
    { command: 'flush', description: t(locale, 'cmd.flush') },
    { command: 'forcemonitor', description: t(locale, 'cmd.forcemonitor') },
    { command: 'stopmonitor', description: t(locale, 'cmd.stopmonitor') },
    { command: 'globalstories', description: t(locale, 'cmd.globalstories') },
    { command: 'welcome', description: t(locale, 'cmd.welcome') },
    { command: 'bugreport', description: t(locale, 'cmd.listbugs') },
  ];
}

function buildLegacyCommands(locale: string, userId?: string) {
  const commands = [...getLegacyBaseCommands(locale)];
  const admin = userId === String(BOT_ADMIN_ID);
  const premium = Boolean(userId && isUserPremium(userId));
  const paidMonitoring = Boolean(userId && getStarsMonitoringEntitlement(userId));
  if (admin || premium || paidMonitoring) {
    commands.push(...getLegacyMonitoringCommands(locale));
  }
  if (admin || premium) {
    commands.push(...getLegacyPremiumCommands(locale));
  }
  if (admin) commands.push(...getLegacyAdminCommands(locale));
  return commands;
}

function buildCommands(locale: string, userId?: string) {
  const commands = [...getStarsBaseCommands(locale)];
  const admin = userId === String(BOT_ADMIN_ID);
  if (admin || (userId && isUserPremium(userId))) {
    commands.push(...getPremiumCommands(locale));
  }
  if (admin) commands.push(...getAdminCommands(locale));
  return commands;
}

function allowedCommandNames(locale: string, userId?: string): Set<string> {
  return new Set(buildCommands(locale, userId).map((item) => item.command));
}

async function syncChatCommands(
  bot: Telegraf<IContextBot>,
  chatId: string,
  userId: string,
  locale: string,
  force = false,
): Promise<void> {
  if (!isStarsMode()) return;
  const cacheKey = `${chatId}:${userId}`;
  if (!force && syncedChats.has(cacheKey)) return;

  const numericChatId = Number(chatId);
  const numericUserId = Number(userId);
  if (!Number.isFinite(numericChatId) || !Number.isFinite(numericUserId)) return;

  // Private chats can use a chat scope. Group and supergroup menus must use a
  // member scope so one admin/Premium user cannot replace everyone else's menu.
  const isGroup = chatId !== userId;
  const scope: any = isGroup
    ? { type: 'chat_member', chat_id: numericChatId, user_id: numericUserId }
    : { type: 'chat', chat_id: numericChatId };

  try {
    if (isGroup) {
      await (bot.telegram as any).callApi('deleteMyCommands', {
        scope: { type: 'chat', chat_id: numericChatId },
      }).catch(() => {});
    }
    await bot.telegram.setMyCommands(buildCommands(locale, userId), { scope });
    db.prepare(
      `INSERT INTO bot_command_scopes (chat_id, user_id, locale, is_group, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET
         locale = excluded.locale,
         is_group = excluded.is_group,
         updated_at = excluded.updated_at`,
    ).run(chatId, userId, locale || 'en', isGroup ? 1 : 0, Math.floor(Date.now() / 1000));
    syncedChats.add(cacheKey);
  } catch (error) {
    console.warn(`[Stars] Could not update command menu for ${chatId}/${userId}:`, error);
  }
}

function prices() {
  return {
    resultPrice: getStarsPrice(),
    weekPrice: getStarsMonitorPrice('week'),
    monthPrice: getStarsMonitorPrice('month'),
    maxTargets: getStarsMonitorTargetLimit(),
  };
}

async function renderStarsStart(ctx: any, bot: Telegraf<IContextBot>): Promise<void> {
  if (ctx.from) await saveUser(ctx.from);
  const locale = ctx.from?.language_code || 'en';
  const userId = String(ctx.from?.id ?? '');
  const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
  await ctx.reply(t(locale, 'stars.startText', prices()), { parse_mode: 'Markdown' });
  await syncChatCommands(bot, chatId, userId, locale, true);
}

async function renderStarsHelp(ctx: any, bot: Telegraf<IContextBot>): Promise<void> {
  const locale = ctx.from?.language_code || 'en';
  const userId = String(ctx.from?.id ?? '');
  const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
  await ctx.reply(t(locale, 'stars.helpText', prices()), { parse_mode: 'Markdown' });
  await syncChatCommands(bot, chatId, userId, locale, true);
}

function monitorPlanKeyboard(locale: string) {
  const weekPrice = getStarsMonitorPrice('week');
  const monthPrice = getStarsMonitorPrice('month');
  return {
    inline_keyboard: [
      [{ text: `7d • ⭐${weekPrice}`, callback_data: 'starsmonitor:buy:week' }],
      [{ text: `30d • ⭐${monthPrice}`, callback_data: 'starsmonitor:buy:month' }],
    ],
  };
}

async function showMonitorPlans(ctx: any): Promise<void> {
  const locale = ctx.from?.language_code || 'en';
  await ctx.reply(t(locale, 'stars.monitorPlans', prices()), {
    parse_mode: 'Markdown',
    reply_markup: monitorPlanKeyboard(locale),
  });
}

function formatExpiry(locale: string, epoch: number): string {
  try {
    return new Date(epoch * 1000).toLocaleString(locale || 'en');
  } catch {
    return new Date(epoch * 1000).toLocaleString();
  }
}

async function showActiveMonitoring(ctx: any, userId: string): Promise<void> {
  const locale = ctx.from?.language_code || 'en';
  const entitlement = getStarsMonitoringEntitlement(userId);
  if (!entitlement) return showMonitorPlans(ctx);

  let monitors = listUserMonitors(userId);
  for (const monitor of monitors) {
    await refreshMonitorUsername(monitor);
  }
  monitors = listUserMonitors(userId);

  let text = t(locale, 'stars.monitorActive', {
    expires: formatExpiry(locale, entitlement.expiresAt),
    count: monitors.length,
    maxTargets: entitlement.maxTargets,
  });
  text += monitors.length
    ? `\n\n${t(locale, 'stars.monitorList', {
        list: monitors.map((monitor, index) => `${index + 1}. ${formatMonitorTarget(monitor)}`).join('\n'),
      })}`
    : `\n\n${t(locale, 'stars.monitorNoTargets')}`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
}

async function handleStarsMonitor(ctx: any, next: () => Promise<void>): Promise<void> {
  const userId = String(ctx.from?.id ?? '');
  if (ctx.from?.id === BOT_ADMIN_ID || isUserPremium(userId)) return next();

  const locale = ctx.from?.language_code || 'en';
  const entitlement = getStarsMonitoringEntitlement(userId);
  const args = String(ctx.message?.text || '').split(/\s+/).slice(1);
  if (!args.length) return showActiveMonitoring(ctx, userId);
  if (!entitlement) return showMonitorPlans(ctx);
  if (userMonitorCount(userId) >= entitlement.maxTargets) {
    return ctx.reply(t(locale, 'stars.monitorLimit', { maxTargets: entitlement.maxTargets }));
  }

  const input = args[0];
  const username = input.replace(/^@/, '');
  let added;
  try {
    added = await addProfileMonitor(userId, username);
  } catch (error) {
    if (String(error).includes('STAR_MONITOR_LIMIT')) {
      return ctx.reply(t(locale, 'stars.monitorLimit', { maxTargets: entitlement.maxTargets }));
    }
    throw error;
  }
  if (!added) return ctx.reply(t(locale, 'stars.monitorAlready'));
  return ctx.reply(t(locale, 'stars.monitorStarted', { target: input }));
}

async function handleStarsUnmonitor(ctx: any, next: () => Promise<void>): Promise<void> {
  const userId = String(ctx.from?.id ?? '');
  if (ctx.from?.id === BOT_ADMIN_ID || isUserPremium(userId)) return next();

  const locale = ctx.from?.language_code || 'en';
  const args = String(ctx.message?.text || '').split(/\s+/).slice(1);
  if (!args.length) return showActiveMonitoring(ctx, userId);

  const input = args[0];
  const username = input.replace(/^@/, '');
  const existing = listUserMonitors(userId).find(
    (monitor) =>
      monitor.target_username?.replace(/^@/, '').toLowerCase() === username.toLowerCase() ||
      monitor.target_id === username,
  );
  if (existing) authorizeStarsMonitorRemoval(userId, existing.target_id);
  try {
    await removeProfileMonitor(userId, username);
  } finally {
    if (existing) clearStarsMonitorRemovalAuthorization(userId, existing.target_id);
  }
  return ctx.reply(t(locale, 'stars.monitorStopped', { target: input }));
}

async function handleSetMonitorPrice(ctx: any): Promise<void> {
  const locale = ctx.from?.language_code || 'en';
  const args = String(ctx.message?.text || '').trim().split(/\s+/).slice(1);
  const plan = args[0] === 'week' || args[0] === 'month' ? args[0] : undefined;
  const value = Number(args[1]);

  if (!plan || !Number.isInteger(value) || value < 1 || value > 10_000) {
    await ctx.reply('Usage: /setmonitorprice <week|month> <1-10000>');
    return;
  }

  const old = getStarsMonitorPrice(plan);
  if (!setStarsMonitorPrice(plan, value, String(ctx.from.id))) {
    await ctx.reply(t(locale, 'stars.adminInvalidPrice'));
    return;
  }
  await ctx.reply(`✅ ${plan === 'week' ? '7-day' : '30-day'} monitoring changed from ⭐${old} to ⭐${value}. Existing invoices keep their original price.`);
}

async function createMonitorInvoice(ctx: any, plan: 'week' | 'month'): Promise<void> {
  const locale = ctx.from?.language_code || 'en';
  if (!isStarsMode() || !areStarsEnabled()) {
    await ctx.answerCbQuery(t(locale, 'stars.paymentUnavailable'), { show_alert: true });
    return;
  }

  const userId = String(ctx.from?.id ?? '');
  const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const price = getStarsMonitorPrice(plan);
  const maxTargets = getStarsMonitorTargetLimit();
  const duration = plan === 'week' ? '7d' : '30d';
  const requestKind = plan === 'week' ? 'monitor_week' : 'monitor_month';

  db.prepare(
    `INSERT INTO star_result_bundles (
       id, user_id, chat_id, target, locale, request_kind, story_ids,
       task_json, result_count, price_stars, status, created_at, expires_at
     ) VALUES (?, ?, ?, 'story-monitoring', ?, ?, '[]', ?, ?, ?, 'OFFERED', ?, ?)`,
  ).run(
    id,
    userId,
    chatId,
    locale,
    requestKind,
    JSON.stringify({
      chatId,
      link: 'story-monitoring',
      linkType: 'username',
      locale,
      initTime: Date.now(),
      user: ctx.from,
      monitorPlan: plan,
    }),
    maxTargets,
    price,
    now,
    now + getBundleTtlMinutes() * 60,
  );

  await (ctx.telegram as any).callApi('sendInvoice', {
    chat_id: chatId,
    title: t(locale, 'stars.monitorInvoiceTitle'),
    description: t(locale, 'stars.monitorInvoiceDescription', { duration, maxTargets }),
    payload: id,
    currency: 'XTR',
    prices: [{
      label: t(locale, 'stars.monitorInvoiceLabel', { duration }),
      amount: price,
    }],
    start_parameter: `monitor_${plan}_${id.replace(/-/g, '')}`,
  });
  await ctx.answerCbQuery();
}

async function migrateExistingCommandScopes(
  bot: Telegraf<IContextBot>,
  force = false,
): Promise<void> {
  if (!isStarsMode()) return;
  const done = db.prepare('SELECT value FROM bot_settings WHERE key = ?').get(
    COMMAND_SCOPE_MIGRATION_KEY,
  ) as { value?: string } | undefined;
  if (!force && done?.value === '1') return;

  const legacyGroups = db.prepare(`
    SELECT DISTINCT group_id
    FROM (
      SELECT CAST(telegram_id AS TEXT) AS group_id
      FROM download_queue
      WHERE CAST(telegram_id AS INTEGER) < 0
      UNION
      SELECT CAST(json_extract(task_details, '$.chatId') AS TEXT) AS group_id
      FROM download_queue
      WHERE json_valid(task_details)
        AND CAST(json_extract(task_details, '$.chatId') AS INTEGER) < 0
      UNION
      SELECT CAST(chat_id AS TEXT) AS group_id
      FROM star_result_bundles
      WHERE CAST(chat_id AS INTEGER) < 0
    )
    WHERE group_id IS NOT NULL
    ORDER BY group_id
  `).all() as { group_id: string }[];

  for (const row of legacyGroups) {
    const groupId = Number(row.group_id);
    if (!Number.isFinite(groupId)) continue;
    try {
      await (bot.telegram as any).callApi('deleteMyCommands', {
        scope: { type: 'chat', chat_id: groupId },
      });
    } catch (error) {
      console.warn(`[Stars] Could not clear legacy group command scope ${row.group_id}:`, error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const trackedMembers = db.prepare(
    `SELECT chat_id, user_id, locale
     FROM bot_command_scopes
     WHERE is_group = 1
     ORDER BY updated_at ASC`,
  ).all() as { chat_id: string; user_id: string; locale?: string }[];
  for (const member of trackedMembers) {
    await syncChatCommands(bot, member.chat_id, member.user_id, member.locale || 'en', true);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const users = db.prepare(
    'SELECT telegram_id, language FROM users ORDER BY created_at ASC',
  ).all() as { telegram_id: string; language?: string }[];
  for (const user of users) {
    await syncChatCommands(bot, user.telegram_id, user.telegram_id, user.language || 'en', true);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  db.prepare(
    `INSERT INTO bot_settings (key, value, updated_at, updated_by)
     VALUES (?, '1', ?, 'migration')
     ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
  ).run(COMMAND_SCOPE_MIGRATION_KEY, Math.floor(Date.now() / 1000));
}

function looksLikeStoryRequest(text: string): boolean {
  return (
    text.startsWith('@') ||
    text.startsWith('+') ||
    /^https?:\/\//i.test(text) ||
    text.includes('t.me/')
  );
}

export async function synchronizeLegacyCommandMenus(
  bot: Telegraf<IContextBot>,
): Promise<void> {
  syncedChats.clear();
  await bot.telegram.setMyCommands(getLegacyBaseCommands('en'));
  await bot.telegram.setMyCommands(
    buildLegacyCommands('en', String(BOT_ADMIN_ID)),
    { scope: { type: 'chat', chat_id: BOT_ADMIN_ID } },
  );

  const trackedScopes = db.prepare(
    `SELECT chat_id, user_id, locale, is_group
     FROM bot_command_scopes
     ORDER BY updated_at ASC`,
  ).all() as { chat_id: string; user_id: string; locale?: string; is_group: number }[];

  const clearedGroups = new Set<string>();
  for (const tracked of trackedScopes) {
    const chatId = Number(tracked.chat_id);
    const userId = Number(tracked.user_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(userId)) continue;
    if (tracked.is_group) {
      if (!clearedGroups.has(tracked.chat_id)) {
        await (bot.telegram as any).callApi('deleteMyCommands', {
          scope: { type: 'chat', chat_id: chatId },
        }).catch(() => {});
        clearedGroups.add(tracked.chat_id);
      }
      await bot.telegram.setMyCommands(
        buildLegacyCommands(tracked.locale || 'en', tracked.user_id),
        { scope: { type: 'chat_member', chat_id: chatId, user_id: userId } },
      ).catch(() => {});
    } else {
      await bot.telegram.setMyCommands(
        buildLegacyCommands(tracked.locale || 'en', tracked.user_id),
        { scope: { type: 'chat', chat_id: chatId } },
      ).catch(() => {});
    }
  }

  const users = db.prepare(
    'SELECT telegram_id, language FROM users ORDER BY created_at ASC',
  ).all() as { telegram_id: string; language?: string }[];
  for (const user of users) {
    const chatId = Number(user.telegram_id);
    if (!Number.isFinite(chatId)) continue;
    await bot.telegram.setMyCommands(
      buildLegacyCommands(user.language || 'en', user.telegram_id),
      { scope: { type: 'chat', chat_id: chatId } },
    ).catch(() => {});
  }
}

export async function synchronizeStarsCommandMenus(
  bot: Telegraf<IContextBot>,
  force = false,
): Promise<void> {
  if (!isStarsMode()) return;
  await bot.telegram.setMyCommands(getStarsBaseCommands('en'));
  await bot.telegram.setMyCommands(buildCommands('en', String(BOT_ADMIN_ID)), {
    scope: { type: 'chat', chat_id: BOT_ADMIN_ID },
  });
  await migrateExistingCommandScopes(bot, force);
}

export function registerStarsCommandSurface(bot: Telegraf<IContextBot>): void {
  initializeStarsModeSafety(bot);
  if (process.env.NODE_ENV === 'test') return;
  if (registered) return;
  registered = true;

  bot.use(async (ctx: any, next: () => Promise<void>) => {
    const rawText = String(ctx.message?.text || '').trim();
    const locale = ctx.from?.language_code || 'en';
    const userId = String(ctx.from?.id ?? '');
    const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
    const commandMatch = rawText.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s|$)/i);
    const command = commandMatch?.[1]?.toLowerCase();

    if (!isStarsMode()) {
      const paidMonitoring = Boolean(userId && getStarsMonitoringEntitlement(userId));
      if (paidMonitoring && command === 'monitor') return handleStarsMonitor(ctx, next);
      if (paidMonitoring && command === 'unmonitor') return handleStarsUnmonitor(ctx, next);
      return next();
    }
if (command === 'start') return renderStarsStart(ctx, bot);
    if (command === 'help') return renderStarsHelp(ctx, bot);
    if (command === 'monitor') return handleStarsMonitor(ctx, next);
    if (command === 'unmonitor') return handleStarsUnmonitor(ctx, next);
    if (command === 'setmonitorprice' && ctx.from?.id === BOT_ADMIN_ID) {
      return handleSetMonitorPrice(ctx);
    }

    if (command && !allowedCommandNames(locale, userId).has(command)) {
      await ctx.reply(t(locale, 'stars.commandUnavailable'));
      await syncChatCommands(bot, chatId, userId, locale, true);
      return;
    }

    if (
      !command &&
      looksLikeStoryRequest(rawText) &&
      !areStarsEnabled() &&
      ctx.from?.id !== BOT_ADMIN_ID &&
      !isUserPremium(userId)
    ) {
      await ctx.reply(t(locale, 'stars.requestPaused'));
      return;
    }

    await next();
    if (userId && chatId) await syncChatCommands(bot, chatId, userId, locale);
  });

  bot.action(/^starsmonitor:buy:(week|month)$/, async (ctx: any) => {
    if (!isStarsMode()) return ctx.answerCbQuery();
    await createMonitorInvoice(ctx, ctx.match[1] as 'week' | 'month');
  });

  setTimeout(async () => {
    if (!isStarsMode()) return;
    try {
      await synchronizeStarsCommandMenus(bot);
    } catch (error) {
      console.error('[Stars] Failed to synchronize command menus:', error);
    }
  }, 3_000).unref?.();
}
