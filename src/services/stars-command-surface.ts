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

const COMMAND_SCOPE_MIGRATION_KEY = 'stars_command_scope_v3';
const syncedChats = new Set<string>();
let registered = false;

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
  const scope: any = chatId === userId
    ? { type: 'chat', chat_id: numericChatId }
    : { type: 'chat_member', chat_id: numericChatId, user_id: numericUserId };

  try {
    await bot.telegram.setMyCommands(buildCommands(locale, userId), { scope });
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
  const added = await addProfileMonitor(userId, username);
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

async function migrateExistingCommandScopes(bot: Telegraf<IContextBot>): Promise<void> {
  if (!isStarsMode()) return;
  const done = db.prepare('SELECT value FROM bot_settings WHERE key = ?').get(
    COMMAND_SCOPE_MIGRATION_KEY,
  ) as { value?: string } | undefined;
  if (done?.value === '1') return;

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

export function registerStarsCommandSurface(bot: Telegraf<IContextBot>): void {
  initializeStarsModeSafety(bot);
  if (process.env.NODE_ENV === 'test') return;
  if (registered) return;
  registered = true;

  bot.use(async (ctx: any, next: () => Promise<void>) => {
    if (!isStarsMode()) return next();

    const rawText = String(ctx.message?.text || '').trim();
    const locale = ctx.from?.language_code || 'en';
    const userId = String(ctx.from?.id ?? '');
    const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
    const commandMatch = rawText.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s|$)/i);
    const command = commandMatch?.[1]?.toLowerCase();

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
      await bot.telegram.setMyCommands(getStarsBaseCommands('en'));
      await bot.telegram.setMyCommands(buildCommands('en', String(BOT_ADMIN_ID)), {
        scope: { type: 'chat', chat_id: BOT_ADMIN_ID },
      });
      await migrateExistingCommandScopes(bot);
    } catch (error) {
      console.error('[Stars] Failed to synchronize command menus:', error);
    }
  }, 3_000).unref?.();
}
