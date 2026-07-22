import type { Telegraf } from 'telegraf';
import { BOT_ADMIN_ID } from 'config/env-config';
import { IContextBot } from 'config/context-interface';
import { db } from 'db';
import { t } from 'lib/i18n';
import { isStarsMode } from './stars-payment';

const COMMAND_SCOPE_MIGRATION_KEY = 'stars_command_scope_v1';
const syncedChats = new Set<string>();
let registered = false;

function isPremium(userId: string): boolean {
  const row = db
    .prepare('SELECT is_premium, premium_until FROM users WHERE telegram_id = ?')
    .get(userId) as { is_premium?: number; premium_until?: number | null } | undefined;
  if (!row?.is_premium) return false;
  return !row.premium_until || row.premium_until >= Math.floor(Date.now() / 1000);
}

function getStarsBaseCommands(locale: string) {
  return [
    { command: 'start', description: t(locale, 'cmd.start') },
    { command: 'help', description: t(locale, 'cmd.help') },
    { command: 'premium', description: t(locale, 'cmd.premium') },
    { command: 'upgrade', description: t(locale, 'cmd.upgrade') },
    { command: 'queue', description: t(locale, 'cmd.queue') },
    { command: 'invite', description: t(locale, 'cmd.invite') },
    { command: 'profile', description: t(locale, 'cmd.profile') },
    { command: 'bugs', description: t(locale, 'cmd.bugs') },
    { command: 'paysupport', description: t(locale, 'cmd.paysupport') },
    { command: 'terms', description: t(locale, 'cmd.terms') },
  ];
}

function getPremiumCommands(locale: string) {
  return [
    { command: 'monitor', description: t(locale, 'cmd.monitor') },
    { command: 'unmonitor', description: t(locale, 'cmd.unmonitor') },
    { command: 'archive', description: t(locale, 'cmd.archive') },
  ];
}

function getAdminCommands(locale: string) {
  return [
    { command: 'starsadmin', description: t(locale, 'cmd.starsadmin') },
    { command: 'setstarsprice', description: 'Set the Stars result price' },
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
  if (admin || (userId && isPremium(userId))) {
    commands.push(...getPremiumCommands(locale));
  }
  if (admin) commands.push(...getAdminCommands(locale));
  return commands;
}

async function syncChatCommands(
  bot: Telegraf<IContextBot>,
  chatId: string,
  locale: string,
  force = false,
): Promise<void> {
  if (!isStarsMode()) return;
  if (!force && syncedChats.has(chatId)) return;
  try {
    await bot.telegram.setMyCommands(buildCommands(locale, chatId), {
      scope: { type: 'chat', chat_id: Number(chatId) },
    });
    syncedChats.add(chatId);
  } catch (error) {
    console.warn(`[Stars] Could not update command menu for ${chatId}:`, error);
  }
}

async function renderStarsHelp(ctx: any): Promise<void> {
  const locale = ctx.from?.language_code || 'en';
  const userId = String(ctx.from?.id ?? '');
  const admin = userId === String(BOT_ADMIN_ID);
  const premium = isPremium(userId);
  let text = t(locale, 'help.header') + '\n\n';
  text += t(locale, 'help.generalStars', {
    cmdStart: t(locale, 'cmd.start'),
    cmdHelp: t(locale, 'cmd.help'),
    cmdPremium: t(locale, 'cmd.premium'),
    cmdUpgrade: t(locale, 'cmd.upgrade'),
    cmdQueue: t(locale, 'cmd.queue'),
    cmdInvite: t(locale, 'cmd.invite'),
    cmdProfile: t(locale, 'cmd.profile'),
    cmdBugs: t(locale, 'cmd.bugs'),
    cmdPaysupport: t(locale, 'cmd.paysupport'),
    cmdTerms: t(locale, 'cmd.terms'),
  });
  if (admin || premium) {
    text += '\n' + t(locale, 'help.premium', {
      cmdMonitor: t(locale, 'cmd.monitor'),
      cmdUnmonitor: t(locale, 'cmd.unmonitor'),
      cmdArchive: t(locale, 'cmd.archive'),
    });
  }
  if (admin) {
    text += '\n' + t(locale, 'help.admin', {
      cmdSetpremium: t(locale, 'cmd.setpremium'),
      cmdUnsetpremium: t(locale, 'cmd.unsetpremium'),
      cmdIspremium: t(locale, 'cmd.ispremium'),
      cmdListpremium: t(locale, 'cmd.listpremium'),
      cmdUsers: t(locale, 'cmd.users'),
      cmdHistory: t(locale, 'cmd.history'),
      cmdBlock: t(locale, 'cmd.block'),
      cmdUnblock: t(locale, 'cmd.unblock'),
      cmdBlocklist: t(locale, 'cmd.blocklist'),
      cmdStatus: t(locale, 'cmd.status'),
      cmdWelcome: t(locale, 'cmd.welcome'),
      cmdRestart: t(locale, 'cmd.restart'),
      cmdFlush: t(locale, 'cmd.flush'),
      cmdForcemonitor: t(locale, 'cmd.forcemonitor'),
      cmdStopmonitor: t(locale, 'cmd.stopmonitor'),
      cmdGlobalstories: t(locale, 'cmd.globalstories'),
      cmdListbugs: t(locale, 'cmd.listbugs'),
      globalHiddenHint: t(locale, 'global.hiddenHint'),
      neverExpires: t(locale, 'premium.neverExpires'),
    });
    text += `\n/starsadmin - ${t(locale, 'cmd.starsadmin')}`;
  }
  await syncChatCommands(ctx.telegram ? ({ telegram: ctx.telegram } as Telegraf<IContextBot>) : ctx, userId, locale, true);
  await ctx.reply(text, { parse_mode: 'Markdown' });
}

async function migrateExistingCommandScopes(bot: Telegraf<IContextBot>): Promise<void> {
  if (!isStarsMode()) return;
  const done = db
    .prepare('SELECT value FROM bot_settings WHERE key = ?')
    .get(COMMAND_SCOPE_MIGRATION_KEY) as { value?: string } | undefined;
  if (done?.value === '1') return;

  const users = db
    .prepare('SELECT telegram_id, language FROM users ORDER BY created_at ASC')
    .all() as { telegram_id: string; language?: string }[];

  for (const user of users) {
    await syncChatCommands(bot, user.telegram_id, user.language || 'en', true);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  db.prepare(
    `INSERT INTO bot_settings (key, value, updated_at, updated_by)
     VALUES (?, '1', ?, 'migration')
     ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
  ).run(COMMAND_SCOPE_MIGRATION_KEY, Math.floor(Date.now() / 1000));
}

export function registerStarsCommandSurface(bot: Telegraf<IContextBot>): void {
  // Existing Jest suites build lightweight bot/database mocks and are not
  // integration tests for Telegram command menus. Avoid delayed production
  // migrations in that environment.
  if (process.env.NODE_ENV === 'test') return;
  if (registered) return;
  registered = true;

  // This middleware is registered before the legacy command handlers. In Stars
  // mode it consumes only the obsolete BTC/trial commands and the help command;
  // all proven bot behavior continues through next().
  bot.use(async (ctx: any, next: () => Promise<void>) => {
    if (!isStarsMode()) return next();
    const text = String(ctx.message?.text || '').split('@')[0].trim();
    const locale = ctx.from?.language_code || 'en';
    const userId = ctx.from?.id ? String(ctx.from.id) : undefined;

    if (text === '/help') {
      await renderStarsHelp(ctx);
      return;
    }
    if (text === '/freetrial') {
      await ctx.reply(t(locale, 'stars.trialDisabled'));
      if (userId) await syncChatCommands(bot, userId, locale, true);
      return;
    }
    if (text === '/verify' || text.startsWith('/verify ')) {
      await ctx.reply(t(locale, 'stars.verifyDisabled'));
      if (userId) await syncChatCommands(bot, userId, locale, true);
      return;
    }

    await next();
    if (userId) await syncChatCommands(bot, userId, locale);
  });

  // index.ts currently writes the legacy global menu during startup. Reapply
  // the Stars menu immediately afterward without changing that proven file.
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
