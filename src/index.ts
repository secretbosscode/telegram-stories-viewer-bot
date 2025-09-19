// src/index.ts

// Global error handlers must be at the absolute top.
import { recordTimeoutError, monitorConsoleErrors } from './config/timeout-monitor';

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL_ERROR: Unhandled Rejection at:', promise, 'reason:', reason);
  recordTimeoutError(reason);
});

process.on('uncaughtException', (error, origin) => {
  console.error('CRITICAL_ERROR: Uncaught Exception:', error, 'origin:', origin);
  recordTimeoutError(error);
});

console.log('Global error handlers have been attached.');
monitorConsoleErrors();

// Redirect console output to a debug log file for easier troubleshooting
import './config/setup-logs';

import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN, LOG_FILE } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { t } from './lib/i18n';
import { session, Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';
import {
  db,
  resetStuckJobs,
  updateFromAddress,
  blockUser,
  unblockUser,
  isUserBlocked,
  listBlockedUsers,
  getOrCreateInviteCode,
  findInviterByCode,
  recordReferral,
  countReferrals,
  getInviterForUser,
  markReferralPaidRewarded,
  wasReferralPaidRewarded,
  recordInvalidLink,
  suspendUserTemp,
  getSuspensionRemaining,
  isUserTemporarilySuspended,
} from './db';
import { getRecentHistoryFx } from './db/effects';
import { processQueue, handleNewTask, getQueueStatusForUser } from './services/queue-manager';
import { saveUser, findUserById, refreshUserUsername } from './repositories/user-repository';
import {
  isUserPremium,
  addPremiumUser,
  removePremiumUser,
  extendPremium,
  getPremiumDaysLeft,
  grantFreeTrial,
  hasUsedFreeTrial,
  calcPremiumDays,
} from './services/premium-service';
import {
  addProfileMonitor,
  removeProfileMonitor,
  userMonitorCount,
  listUserMonitors,
  startMonitorLoop,
  stopMonitorLoop,
  CHECK_INTERVAL_HOURS,
  MAX_MONITORS_PER_USER,
  formatMonitorTarget,
  refreshMonitorUsername,
  forceCheckMonitors,
} from './services/monitor-service';
import {
  resumePendingChecks,
  setBotInstance,
  verifyPaymentByTxid,
} from './services/btc-payment';
import { getStatusText } from './services/admin-stats';
import { scheduleDatabaseBackups } from './services/backup-service';
import { handleUpgrade } from 'controllers/upgrade';
import { handlePremium } from 'controllers/premium';
import { sendProfileMedia } from 'controllers/send-profile-media';
import { notifyAdmin } from 'controllers/send-message';
import { UserInfo } from 'types';
import {
  sendTemporaryMessage,
  updatePremiumPinnedMessage,
  isValidStoryLink,
} from 'lib';
import {
  recordProfileRequestFx,
  wasProfileRequestedRecentlyFx,
  getProfileRequestCooldownRemainingFx,
  getLastVerifyAttemptFx,
  updateVerifyAttemptFx,
  addBugReportFx,
  listBugReportsFx,
  countBugReportsLastDayFx,
  getEarliestBugReportTimeLastDayFx,
  flushQueueFx,
} from './db/effects';

export const bot = new Telegraf<IContextBot>(BOT_TOKEN!);
setBotInstance(bot);
const RESTART_COMMAND = 'restart';
const extraOptions: any = { link_preview_options: { is_disabled: true } };
const LIST_PAGE_SIZE = 100;
export const GLOBAL_STORIES_PAGE_SIZE = 50;
export const GLOBAL_STORIES_CALLBACK_PREFIX = 'globalstories:';

// =============================
// Command definitions
// =============================
function getBaseCommands(locale: string) {
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

function getPremiumCommands(locale: string) {
  return [
    { command: 'monitor', description: t(locale, 'cmd.monitor') },
    { command: 'unmonitor', description: t(locale, 'cmd.unmonitor') },
    { command: 'archive', description: t(locale, 'cmd.archive') },
  ];
}

function getAdminCommands(locale: string) {
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

async function updateUserCommands(
  ctx: IContextBot,
  isAdmin: boolean,
  isPremium: boolean,
) {
  const locale = ctx.from?.language_code || 'en';
  const commands = [...getBaseCommands(locale)];
  if (isPremium || isAdmin) {
    commands.push(...getPremiumCommands(locale));
  }
  if (isAdmin) {
    commands.push(...getAdminCommands(locale));
  }
  await ctx.telegram.setMyCommands(commands, {
    scope: { type: 'chat', chat_id: ctx.chat!.id },
  });
}

const logPath = LOG_FILE;
const logDir = path.dirname(logPath);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

bot.use(session());
bot.use(async (ctx, next) => {
  if (ctx.from?.is_bot) {
    if (ctx.from.id && ctx.from.id !== bot.botInfo?.id) {
      blockUser(String(ctx.from.id), true);
    }
    return;
  }
  if (ctx.from && isUserBlocked(String(ctx.from.id))) {
    return;
  }
  if (
    ctx.from &&
    ctx.from.id !== BOT_ADMIN_ID &&
    isUserTemporarilySuspended(String(ctx.from.id))
  ) {
    const remaining = getSuspensionRemaining(String(ctx.from.id));
    const m = Math.ceil(remaining / 60);
    try {
      await ctx.reply(`🚫 You are temporarily suspended for ${m} minute${m === 1 ? '' : 's'}.`);
    } catch {}
    return;
  }
  if (ctx.from) {
    // Update user's language in the database on every interaction
    saveUser(ctx.from);
  }
  await next();
});
bot.use(async (ctx, next) => {
  const text = 'message' in ctx && ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  console.log(`[Update] from ${ctx.from?.id} type=${ctx.updateType} text=${text}`);
  await next();
});
bot.catch((error, ctx) => {
  console.error(`A global error occurred for chat ${ctx.chat?.id}:`, error);
  const logEntry =
    `[${new Date().toISOString()}] chat:${ctx.chat?.id} ` +
    (error instanceof Error ? error.stack || error.message : String(error)) +
    '\n';
  try {
    fs.appendFileSync(logPath, logEntry);
  } catch (e) {
    console.error('Failed to write to log file', e);
  }
  const locale = ctx.from?.language_code || 'en';
  ctx
    .reply(t(locale, 'error.unexpected'))
    .catch(() => {});
});

bot.use(async (ctx, next) => {
  await next();
  try {
    const id = ctx.from?.id;
    if (!id) return;
    const locale = ctx.from?.language_code;
    const text =
      ctx.updateType === 'message' && ctx.message && 'text' in ctx.message
        ? ctx.message.text
        : '';
    if (text.startsWith('/premium')) return;
    if (isUserPremium(String(id))) {
      const days = getPremiumDaysLeft(String(id));
      await updatePremiumPinnedMessage(
        bot,
        ctx.chat!.id,
        String(id),
        days,
        locale,
      );
    }
  } catch (e) {
    console.error('premium middleware error', e);
  }
});

function isActivated(userId: number): boolean {
  try {
    const user = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(String(userId));
    return !!user;
  } catch (error) {
    console.error(`[isActivated] Database check failed for user ${userId}:`, error);
    return false;
  }
}

// =========================================================================
//  COMMAND & EVENT HANDLERS
// =========================================================================

bot.start(async (ctx) => {
  await saveUser(ctx.from);
  const payload = ctx.startPayload;
  if (payload) {
    const inviter = findInviterByCode(payload);
    if (inviter && inviter !== String(ctx.from.id)) {
      recordReferral(inviter, String(ctx.from.id));
      const total = countReferrals(inviter);
      if (total % 5 === 0) {
        extendPremium(inviter, 7);
        try {
          const inviterLang = findUserById(inviter)?.language;
          await ctx.telegram.sendMessage(inviter, t(inviterLang, 'referral.fiveUsers'));
        } catch {}
      }
    }
  }
  const inviteCode = getOrCreateInviteCode(String(ctx.from.id));
  const isAdmin = ctx.from.id === BOT_ADMIN_ID;
  const isPremium = isUserPremium(String(ctx.from.id));
  const locale = ctx.from.language_code || 'en';
  let msg = t(locale, 'start.welcome') + '\n\n' + t(locale, 'start.instructions');
  if (
    !isUserPremium(String(ctx.from.id)) &&
    !hasUsedFreeTrial(String(ctx.from.id), ctx.from.username)
  ) {
    msg = t(locale, 'start.freeTrial') + msg;
  }
  const botUser = bot.botInfo?.username || 'this_bot';
  const link = `https://t.me/${botUser}?start=${inviteCode}`;
  msg += `\n\n${t(locale, 'start.invite', { link })}`;
  msg += `\n${t(locale, 'start.inviteSuffix')}`;
  await ctx.reply(msg, { ...extraOptions, parse_mode: 'Markdown' });
  await updateUserCommands(ctx, isAdmin, isPremium);
});

bot.command('help', async (ctx) => {
  const locale = ctx.from.language_code || 'en';
  let finalHelpText = t(locale, 'help.header') + '\n\n';
  finalHelpText += t(locale, 'help.general', {
    cmdStart: t(locale, 'cmd.start'),
    cmdHelp: t(locale, 'cmd.help'),
    cmdPremium: t(locale, 'cmd.premium'),
    cmdUpgrade: t(locale, 'cmd.upgrade'),
    cmdFreetrial: t(locale, 'cmd.freetrial'),
    cmdQueue: t(locale, 'cmd.queue'),
    cmdInvite: t(locale, 'cmd.invite'),
    cmdProfile: t(locale, 'cmd.profile'),
    cmdVerify: t(locale, 'cmd.verify'),
    cmdBugs: t(locale, 'cmd.bugs'),
  });

  const isAdmin = ctx.from.id === BOT_ADMIN_ID;
  const isPremium = isUserPremium(String(ctx.from.id));
  if (isPremium || isAdmin) {
    finalHelpText +=
      '\n' +
      t(locale, 'help.premium', {
        cmdMonitor: t(locale, 'cmd.monitor'),
        cmdUnmonitor: t(locale, 'cmd.unmonitor'),
        cmdArchive: t(locale, 'cmd.archive'),
      });
  }

  if (isAdmin) {
    finalHelpText +=
      '\n' +
      t(locale, 'help.admin', {
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
    }
  await ctx.reply(finalHelpText, { parse_mode: 'Markdown' });
  await updateUserCommands(ctx, isAdmin, isPremium);
});

bot.command('premium', handlePremium);

bot.command('upgrade', async (ctx) => {
  await handleUpgrade(ctx);
});

bot.command('freetrial', async (ctx) => {
  const locale = ctx.from.language_code || 'en';
  const userId = String(ctx.from.id);
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  if (isUserPremium(userId)) {
    return ctx.reply(t(locale, 'premium.already'));
  }
  if (hasUsedFreeTrial(userId, ctx.from.username)) {
    return ctx.reply(t(locale, 'premium.freeTrialUsed'));
  }
  grantFreeTrial(userId);
  notifyAdmin({
    task: { chatId: userId, user: ctx.from } as any,
    status: 'info',
    baseInfo: t('en', 'admin.freeTrialRedeemed', {
      user: ctx.from.username ? '@' + ctx.from.username : userId,
    }),
  });
  await ctx.reply(t(locale, 'premium.freeTrialActivated'));
});

bot.command('verify', async (ctx) => {
  const locale = ctx.from.language_code || 'en';
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    if (isUserPremium(String(ctx.from.id))) {
      return ctx.reply(t(locale, 'premium.already'));
    }
    return ctx.reply(t(locale, 'verify.usage'));
  }
  const [txid] = args;
  if (!txid) return ctx.reply(t(locale, 'verify.invalidArgs'));
  const isAdmin = ctx.from.id === BOT_ADMIN_ID;
  if (!isAdmin) {
    const last = await getLastVerifyAttemptFx(String(ctx.from.id));
    if (last && Math.floor(Date.now() / 1000) - last < 300) {
      const wait = 300 - (Math.floor(Date.now() / 1000) - last);
      return ctx.reply(t(locale, 'verify.wait', { seconds: wait }));
    }
    await updateVerifyAttemptFx(String(ctx.from.id));
  }
  const invoice = await verifyPaymentByTxid(txid);
  if (invoice && invoice.paid_at) {
    const daysAdded = calcPremiumDays(invoice.invoice_amount, invoice.paid_amount);
    extendPremium(String(ctx.from.id), daysAdded);
    const inviter = getInviterForUser(String(ctx.from.id));
    if (inviter && !wasReferralPaidRewarded(String(ctx.from.id))) {
      extendPremium(inviter, daysAdded);
      markReferralPaidRewarded(String(ctx.from.id));
      try {
        const inviterLang = findUserById(inviter)?.language;
        await ctx.telegram.sendMessage(inviter, t(inviterLang, 'referral.paid', { days: daysAdded }));
      } catch {}
    }
    if (ctx.session?.upgrade && ctx.session.upgrade.invoice.id === invoice.id) {
      ctx.session.upgrade = undefined;
    }
    const days = getPremiumDaysLeft(String(ctx.from.id));
    await updatePremiumPinnedMessage(
      bot,
      ctx.chat!.id,
      String(ctx.from.id),
      days,
      locale,
      true,
    );
    notifyAdmin({
      task: { chatId: String(ctx.from.id), user: ctx.from } as any,
      status: 'info',
      baseInfo: t('en', 'admin.upgradePayment', {
        user: ctx.from.username ? '@' + ctx.from.username : ctx.from.id,
        amount: invoice.paid_amount.toFixed(8),
      }),
    });
    return ctx.reply(t(locale, 'verify.success', { days: daysAdded }));
  }
  await ctx.reply(t(locale, 'verify.failure'));
});

bot.command('queue', async (ctx) => {
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  const msg = await getQueueStatusForUser(String(ctx.from.id), locale);
  await sendTemporaryMessage(bot, ctx.chat!.id, msg);
});

bot.command('invite', async (ctx) => {
  const locale = ctx.from.language_code || 'en';
  const code = getOrCreateInviteCode(String(ctx.from.id));
  const botUser = bot.botInfo?.username || 'this_bot';
  const link = `https://t.me/${botUser}?start=${code}`;
  await ctx.reply(t(locale, 'invite.msg', { link }));
});

bot.command('profile', async (ctx) => {
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply(t(locale, 'profile.usage'));
  }
  const input = args[0];
  const userId = String(ctx.from.id);
  const isAdmin = ctx.from.id === BOT_ADMIN_ID;
  const isPremium = isUserPremium(userId);
  const cooldown = isAdmin ? 0 : isPremium ? 2 : 12;

  if (
    await wasProfileRequestedRecentlyFx({
      telegram_id: userId,
      target_username: input,
      hours: cooldown,
    })
  ) {
    const remaining = await getProfileRequestCooldownRemainingFx({
      telegram_id: userId,
      target_username: input,
      hours: cooldown,
    });
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    return sendTemporaryMessage(
      bot,
      ctx.chat!.id,
      t(locale, 'profile.cooldown', {
        user: input,
        hours: cooldown,
        h,
        m,
      }),
    );
  }

  await recordProfileRequestFx({ telegram_id: userId, target_username: input });
  await sendProfileMedia(ctx.chat!.id, input, ctx.from);
});

bot.command('archive', async (ctx) => {
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  const userId = String(ctx.from.id);
  const isAdmin = ctx.from.id === BOT_ADMIN_ID;
  const isPremium = isUserPremium(userId);
  if (!isAdmin && !isPremium) {
    return ctx.reply(t(locale, 'monitor.premiumOnly'));
  }
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply(t(locale, 'archive.usage'));
  }
  const username = args[0].replace(/^@/, '');
  const task: UserInfo = {
    chatId: String(ctx.chat.id),
    link: username,
    linkType: 'username',
    locale: ctx.from.language_code || '',
    user: ctx.from,
    initTime: Date.now(),
    isPremium: isPremium,
    storyRequestType: 'archived',
  };
  handleNewTask(task);
});

function getContextChatId(ctx: IContextBot): number | undefined {
  if (ctx.chat?.id) {
    return ctx.chat.id;
  }
  const callbackMessage = ctx.callbackQuery?.message;
  if (callbackMessage && 'chat' in callbackMessage) {
    const chat = (callbackMessage as { chat?: { id?: number } }).chat;
    if (chat?.id) {
      return chat.id;
    }
  }
  return undefined;
}

async function enqueueGlobalStories(
  ctx: IContextBot,
  includeHidden: boolean,
): Promise<boolean> {
  const user = ctx.from;
  if (!user) return false;
  const chatId = getContextChatId(ctx);
  if (typeof chatId === 'undefined') return false;

  const task: UserInfo = {
    chatId: String(chatId),
    link: 'global',
    linkType: 'username',
    locale: user.language_code || '',
    user,
    initTime: Date.now(),
    storyRequestType: 'global',
    includeHiddenStories: includeHidden ? true : undefined,
  };
  await handleNewTask(task);
  return true;
}

bot.command('globalstories', async (ctx) => {
  const locale = ctx.from.language_code || 'en';
  if (ctx.from.id !== BOT_ADMIN_ID) {
    return ctx.reply(t(locale, 'global.adminOnly'));
  }
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));

  const text = ctx.message?.text ?? '';
  const args = text.split(' ').slice(1);
  const includeHidden = args.some((arg) => arg.toLowerCase() === 'hidden');

  await enqueueGlobalStories(ctx, includeHidden);

  if (!includeHidden) {
    await ctx.reply(t(locale, 'global.hiddenHint'), {
      reply_markup: {
        inline_keyboard: [[{ text: t(locale, 'global.hiddenButton'), callback_data: 'globalstories:hidden' }]],
      },
    });
  }
});

bot.action('globalstories:hidden', async (ctx) => {
  const locale = ctx.from?.language_code || 'en';
  if (!ctx.from) {
    await ctx.answerCbQuery();
    return;
  }
  if (ctx.from.id !== BOT_ADMIN_ID) {
    await ctx.answerCbQuery(t(locale, 'global.adminOnly'), { show_alert: true });
    return;
  }
  if (!isActivated(ctx.from.id)) {
    await ctx.answerCbQuery(t(locale, 'msg.startFirst'), { show_alert: true });
    return;
  }

  const started = await enqueueGlobalStories(ctx, true);
  if (started) {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  } else {
    await ctx.answerCbQuery();
  }
});

bot.command('monitor', async (ctx) => {
  const locale = ctx.from.language_code || 'en';
  const userId = String(ctx.from.id);
  const isAdmin = ctx.from.id === BOT_ADMIN_ID;
  const isPremium = isUserPremium(userId);
  if (!isAdmin && !isPremium) {
    return ctx.reply(t(locale, 'monitor.premiumOnly'));
  }
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) {
    let list = listUserMonitors(userId);
    for (const m of list) {
      await refreshMonitorUsername(m);
    }
    list = listUserMonitors(userId);
    if (list.length === 0) {
      const limitMsg = isAdmin
        ? t(locale, 'monitor.unlimited') + ' '
        : t(locale, 'monitor.limitMsg', { max: MAX_MONITORS_PER_USER }) + ' ';
      return ctx.reply(
        t(locale, 'monitor.usage', {
          limitMsg,
          hours: CHECK_INTERVAL_HOURS,
        })
      );
    }
    const limit = isAdmin ? '∞' : MAX_MONITORS_PER_USER;
    const msg = t(locale, 'monitor.list', {
      count: list.length,
      limit,
      list: list
        .map((m, i) => `${i + 1}. ${formatMonitorTarget(m)}`)
        .join('\n'),
      hours: CHECK_INTERVAL_HOURS,
    });
    return ctx.reply(msg);
  }
  const input = args[0];
  const username = input.replace(/^@/, '');
  if (!isAdmin) {
    if (userMonitorCount(userId) >= MAX_MONITORS_PER_USER) {
      return ctx.reply(t(locale, 'monitor.limit', { max: MAX_MONITORS_PER_USER }));
    }
  }
  const added = await addProfileMonitor(userId, username);
  if (!added) {
    return ctx.reply(t(locale, 'monitor.already'));
  }
  const currentCount = userMonitorCount(userId);
  const remaining = Math.max(MAX_MONITORS_PER_USER - currentCount, 0);
  const remainingText = isAdmin
    ? t(locale, 'monitor.unlimited')
    : t(locale, 'monitor.remaining', {
        count: remaining,
        plural: remaining === 1 ? '' : 's',
      });
  await ctx.reply(
    t(locale, 'monitor.started', { user: input, remaining: remainingText })
  );
});

bot.command('unmonitor', async (ctx) => {
  const locale = ctx.from.language_code || 'en';
  const userId = String(ctx.from.id);
  const isAdmin = ctx.from.id === BOT_ADMIN_ID;
  const isPremium = isUserPremium(userId);
  if (!isAdmin && !isPremium) {
    return ctx.reply(t(locale, 'monitor.premiumOnly'));
  }
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) {
    let list = listUserMonitors(userId);
    for (const m of list) {
      await refreshMonitorUsername(m);
    }
    list = listUserMonitors(userId);
    if (list.length === 0) {
      return ctx.reply(t(locale, 'monitor.none'));
    }
    const msg = t(locale, 'monitor.current', {
      list: list
        .map((m, i) => `${i + 1}. ${formatMonitorTarget(m)}`)
        .join('\n'),
    });
    return ctx.reply(msg);
  }
  const inputUn = args[0];
  const username = inputUn.replace(/^@/, '');
  await removeProfileMonitor(userId, username);
  await ctx.reply(t(locale, 'monitor.stopped', { user: inputUn }));
});

// --- Admin Commands ---

bot.command('status', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const text = getStatusText();
  await ctx.reply(text);
});

bot.command('restart', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  await ctx.reply(t(locale, 'admin.confirmRestart'), {
    reply_markup: {
      inline_keyboard: [[{ text: t(locale, 'admin.restartButton'), callback_data: RESTART_COMMAND }]],
    },
  });
});

// FIX: Restored full implementation for all admin commands.
bot.command('setpremium', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply(t(locale, 'admin.setpremiumUsage'));
    let telegramId: string | undefined, username: string | undefined;
    if (args[0].startsWith('@')) {
      username = args[0].replace('@', '');
      const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(username) as { telegram_id?: string };
      if (!row?.telegram_id) return ctx.reply(t(locale, 'user.notFound'));
      telegramId = row.telegram_id;
    } else if (/^\d+$/.test(args[0])) {
      telegramId = args[0];
    } else { return ctx.reply(t(locale, 'argument.invalid')); }
    if (!telegramId) return ctx.reply(t(locale, 'telegramId.resolveFail'));
    const days = args[1] ? parseInt(args[1], 10) : undefined;
    addPremiumUser(telegramId, username, days);
    const userLabel = username ? '@'+username : telegramId;
    const daysText = days ? t(locale, 'admin.daysSuffix', { count: days }) : '';
    await ctx.reply(t(locale, 'admin.setpremiumSuccess', { user: userLabel, days: daysText }));
  } catch (e) { console.error("Error in /setpremium:", e); await ctx.reply(t(locale, 'error.generic')); }
});

bot.command('unsetpremium', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply(t(locale, 'admin.unsetpremiumUsage'));
    let telegramId: string | undefined, username: string | undefined;
    if (args[0].startsWith('@')) {
      username = args[0].replace('@', '');
      const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(username) as { telegram_id?: string };
      if (!row?.telegram_id) return ctx.reply(t(locale, 'user.notFound'));
      telegramId = row.telegram_id;
    } else if (/^\d+$/.test(args[0])) {
      telegramId = args[0];
    } else { return ctx.reply(t(locale, 'argument.invalid')); }
    if (!telegramId) return ctx.reply(t(locale, 'telegramId.resolveFail'));
    removePremiumUser(telegramId);
    const userLabel = username ? '@'+username : telegramId;
    await ctx.reply(t(locale, 'admin.unsetpremiumSuccess', { user: userLabel }));
  } catch (e) { console.error("Error in /unsetpremium:", e); await ctx.reply(t(locale, 'error.generic')); }
});

bot.command('ispremium', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply(t(locale, 'admin.ispremiumUsage'));
    let telegramId: string | undefined, username: string | undefined;
    if (args[0].startsWith('@')) {
      username = args[0].replace('@', '');
      const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(username) as { telegram_id?: string };
      if (!row?.telegram_id) return ctx.reply(t(locale, 'user.notFound'));
      telegramId = row.telegram_id;
    } else if (/^\d+$/.test(args[0])) {
      telegramId = args[0];
    } else { return ctx.reply(t(locale, 'argument.invalid')); }
    if (!telegramId) return ctx.reply(t(locale, 'telegramId.resolveFail'));
    const premium = isUserPremium(telegramId);
    const userLabel = username ? '@'+username : telegramId;
    await ctx.reply(
      premium
        ? t(locale, 'admin.ispremiumYes', { user: userLabel })
        : t(locale, 'admin.ispremiumNo', { user: userLabel })
    );
  } catch (e) { console.error("Error in /ispremium:", e); await ctx.reply(t(locale, 'error.generic')); }
});

async function sendPremiumPage(ctx: any, page: number, edit = false) {
  const locale = ctx.from.language_code || 'en';
  const offset = page * LIST_PAGE_SIZE;
  let rows = db
    .prepare(
      'SELECT telegram_id, username, is_bot FROM users WHERE is_premium = 1 ORDER BY telegram_id LIMIT ? OFFSET ?',
    )
    .all(LIST_PAGE_SIZE, offset) as any[];
  const limit = pLimit(5);
  const valid: any[] = [];
  await Promise.all(
    rows.map((u) =>
      limit(async () => {
        const name = await refreshUserUsername(ctx.telegram, u);
        if (typeof name === 'undefined') return;
        u.username = name;
        valid.push(u);
      }),
    ),
  );
  rows = valid;
  const total = db
    .prepare('SELECT COUNT(*) as c FROM users WHERE is_premium = 1')
    .get().c as number;
  if (!rows.length && page === 0) {
    return ctx.reply(t(locale, 'premium.noneFound'));
  }
  let msg = t(locale, 'premium.usersHeader', { count: total }) + '\n';
  rows.forEach((u, i) => {
    const days = getPremiumDaysLeft(String(u.telegram_id));
    const daysText =
      days === Infinity ? t(locale, 'premium.neverExpires') : `${days}d`;
    const type = u.is_bot ? t(locale, 'label.bot') : t(locale, 'label.user');
    msg += `${offset + i + 1}. ${u.username ? '@' + u.username : u.telegram_id} [${type}] - ${daysText}\n`;
  });
  const buttons: any[] = [];
  if (offset > 0)
    buttons.push({ text: t(locale, 'pagination.prev'), callback_data: `premium:${page - 1}` });
  if (offset + rows.length < total)
    buttons.push({ text: t(locale, 'pagination.next'), callback_data: `premium:${page + 1}` });
  const opts: any = {
    ...extraOptions,
    reply_markup: buttons.length ? { inline_keyboard: [buttons] } : undefined,
  };
  if (edit) await ctx.editMessageText(msg, opts);
  else await ctx.reply(msg, opts);
}

bot.command('listpremium', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) {
    const locale = ctx.from.language_code || 'en';
    return ctx.reply(t(locale, 'msg.startFirst'));
  }
  await sendPremiumPage(ctx, 0);
});

bot.command('block', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply(t(locale, 'admin.blockUsage'));
    let telegramId: string | undefined;
    if (args[0].startsWith('@')) {
      const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(args[0].replace('@','')) as { telegram_id?: string };
      if (!row?.telegram_id) return ctx.reply(t(locale, 'user.notFound'));
      telegramId = row.telegram_id;
    } else if (/^\d+$/.test(args[0])) {
      telegramId = args[0];
    } else { return ctx.reply(t(locale, 'argument.invalid')); }
    const row = db.prepare('SELECT is_bot FROM users WHERE telegram_id = ?').get(telegramId!) as { is_bot?: number } | undefined;
    blockUser(telegramId!, row?.is_bot === 1);
    await ctx.reply(t(locale, 'block.success', { user: telegramId }));
  } catch (e) { console.error('Error in /block:', e); await ctx.reply(t(locale, 'error.generic')); }
});

bot.command('unblock', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply(t(locale, 'admin.unblockUsage'));
    let telegramId: string | undefined;
    if (args[0].startsWith('@')) {
      const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(args[0].replace('@','')) as { telegram_id?: string };
      if (!row?.telegram_id) return ctx.reply(t(locale, 'user.notFound'));
      telegramId = row.telegram_id;
    } else if (/^\d+$/.test(args[0])) {
      telegramId = args[0];
    } else { return ctx.reply(t(locale, 'argument.invalid')); }
    unblockUser(telegramId!);
    await ctx.reply(t(locale, 'unblock.success', { user: telegramId }));
  } catch (e) { console.error('Error in /unblock:', e); await ctx.reply(t(locale, 'error.generic')); }
});

bot.command('blocklist', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  try {
    const rows = listBlockedUsers();
    if (!rows.length) return ctx.reply(t(locale, 'blocked.none'));
    let msg = t(locale, 'blocked.usersHeader', { count: rows.length }) + '\n';
    rows.forEach((u, i) => {
      const type = u.is_bot ? t(locale, 'label.bot') : t(locale, 'label.user');
      msg += `${i + 1}. ${u.telegram_id} [${type}] at ${new Date(u.blocked_at * 1000).toLocaleDateString()}\n`;
    });
    await ctx.reply(msg);
  } catch (e) { console.error('Error in /blocklist:', e); await ctx.reply(t(locale, 'error.generic')); }
});

async function sendUsersPage(ctx: any, page: number, edit = false) {
  const locale = ctx.from.language_code || 'en';
  const offset = page * LIST_PAGE_SIZE;
  let rows = db
    .prepare(
      'SELECT telegram_id, username, is_premium, is_bot, language FROM users ORDER BY telegram_id LIMIT ? OFFSET ?',
    )
    .all(LIST_PAGE_SIZE, offset) as any[];
  const limit = pLimit(5);
  const valid: any[] = [];
  await Promise.all(
    rows.map((u) =>
      limit(async () => {
        const name = await refreshUserUsername(ctx.telegram, u);
        if (typeof name === 'undefined') return;
        u.username = name;
        valid.push(u);
      }),
    ),
  );
  rows = valid;
  const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c as number;
  if (!rows.length && page === 0) {
    return ctx.reply(t(locale, 'users.none'));
  }
  let msg = t(locale, 'users.listHeader', { count: total }) + '\n';
  rows.forEach((u, i) => {
    const premiumLabel = u.is_premium
      ? t(locale, 'label.premium')
      : t(locale, 'label.free');
    const type = u.is_bot ? t(locale, 'label.bot') : t(locale, 'label.user');
    const lang = u.language ? ` (${u.language})` : '';
    msg += `${offset + i + 1}. ${u.username ? '@' + u.username : u.telegram_id} [${premiumLabel}, ${type}]${lang}\n`;
  });
  const buttons: any[] = [];
  if (offset > 0)
    buttons.push({ text: t(locale, 'pagination.prev'), callback_data: `users:${page - 1}` });
  if (offset + rows.length < total)
    buttons.push({ text: t(locale, 'pagination.next'), callback_data: `users:${page + 1}` });
  const opts: any = {
    ...extraOptions,
    reply_markup: buttons.length ? { inline_keyboard: [buttons] } : undefined,
  };
  if (edit) await ctx.editMessageText(msg, opts);
  else await ctx.reply(msg, opts);
}

bot.command('users', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) {
    const locale = ctx.from.language_code || 'en';
    return ctx.reply(t(locale, 'msg.startFirst'));
  }
  await sendUsersPage(ctx, 0);
});

bot.command('history', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  try {
    const rows = await getRecentHistoryFx(50);
    if (!rows.length) return ctx.reply(t(locale, 'history.none'));
    let msg = t(locale, 'history.listHeader') + '\n';
    rows.forEach((r: any, i: number) => {
      const date = new Date(r.enqueued_ts * 1000).toLocaleDateString();
      const user = r.username ? `@${r.username}` : r.telegram_id;
      const type = r.is_bot ? t(locale, 'label.bot') : t(locale, 'label.user');
      msg += `${i + 1}. ${user} [${type}] -> ${r.target_username} [${r.status}] ${date}\n`;
    });
    await ctx.reply(msg, { link_preview_options: { is_disabled: true } });
  } catch (e) {
    console.error('Error in /history:', e);
    await ctx.reply(t(locale, 'error.generic'));
  }
});

bot.command('bugreport', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  try {
    const rows = await listBugReportsFx();
    if (!rows.length) return ctx.reply(t(locale, 'bugs.none'));
    let msg = t(locale, 'bugs.listHeader') + '\n';
    rows.forEach((b: any, i: number) => {
      const date = new Date(b.created_at * 1000).toLocaleDateString();
      const user = b.username ? `@${b.username}` : b.telegram_id;
      msg += `${i + 1}. ${user} - ${b.description} (${date})\n`;
    });
    await ctx.reply(msg);
  } catch (e) {
    console.error('Error in /bugreport:', e);
    await ctx.reply(t(locale, 'error.generic'));
  }
});

bot.command('bugs', async (ctx) => {
  const locale = ctx.from.language_code || 'en';
  const userId = String(ctx.from.id);
  const isAdmin = ctx.from.id === BOT_ADMIN_ID;
  const isPremium = isUserPremium(userId);
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  const args = ctx.message.text.split(' ').slice(1);


  if (!args.length) {
    return ctx.reply(t(locale, 'bug.usage'));
  }

  try {
    if (!isAdmin) {
      const limit = isPremium ? 3 : 1;
      const count = await countBugReportsLastDayFx(userId);
      if (count >= limit) {
        const earliest = await getEarliestBugReportTimeLastDayFx(userId);
        if (earliest) {
          const now = Math.floor(Date.now() / 1000);
          const remaining = earliest + 86400 - now;
          if (remaining > 0) {
            const h = Math.floor(remaining / 3600);
            const m = Math.floor((remaining % 3600) / 60);
            return sendTemporaryMessage(
              bot,
              ctx.chat!.id,
              t(locale, 'bug.cooldown', { h, m }),
            );
          }
        }
      }
    }
    await addBugReportFx({
      telegram_id: userId,
      username: ctx.from.username,
      description: args.join(' '),
    });
    await ctx.reply(t(locale, 'bug.reported'));
  } catch (e) {
    console.error('Error in /bugs:', e);
    await ctx.reply(t(locale, 'error.generic'));
  }
});

bot.command('flush', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  try {
    const count = await flushQueueFx();
    await ctx.reply(t(locale, 'queue.flushed', { count }));
  } catch (e) {
    console.error('Error in /flush:', e);
    await ctx.reply(t(locale, 'error.generic'));
  }
});

bot.command('forcemonitor', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  try {
    const count = await forceCheckMonitors();
    await ctx.reply(t(locale, 'monitor.forceRun', { count }));
  } catch (e) {
    console.error('Error in /forcemonitor:', e);
    await ctx.reply(t(locale, 'error.generic'));
  }
});

bot.command('stopmonitor', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  if (!isActivated(ctx.from.id)) return ctx.reply(t(locale, 'msg.startFirst'));
  try {
    stopMonitorLoop();
    await ctx.reply(t(locale, 'monitor.loopStopped'));
  } catch (e) {
    console.error('Error in /stopmonitor:', e);
    await ctx.reply(t(locale, 'error.generic'));
  }
});

bot.command('welcome', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  const locale = ctx.from.language_code || 'en';
  await ctx.reply(t(locale, 'msg.botStart'), {
    reply_markup: {
      keyboard: [['/start']],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
});

// --- Handle button presses ---
export async function handleCallbackQuery(ctx: IContextBot) {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  if (data === RESTART_COMMAND && ctx.from?.id == BOT_ADMIN_ID) {
    const locale = ctx.from?.language_code || 'en';
    await ctx.answerCbQuery(t(locale, 'admin.restarting'));
    try {
      await ctx.deleteMessage();
    } catch {}
    await ctx.telegram.sendMessage(BOT_ADMIN_ID, t(locale, 'admin.restarting'));
    process.exit();
  }

  if (data.startsWith('users:') && ctx.from?.id == BOT_ADMIN_ID) {
    const page = Number(data.split(':')[1] || '0');
    await sendUsersPage(ctx, page, true);
    await ctx.answerCbQuery();
    return;
  }
  if (data.startsWith('premium:') && ctx.from?.id == BOT_ADMIN_ID) {
    const page = Number(data.split(':')[1] || '0');
    await sendPremiumPage(ctx, page, true);
    await ctx.answerCbQuery();
    return;
  }

  if (data.startsWith(GLOBAL_STORIES_CALLBACK_PREFIX) && ctx.from?.id === BOT_ADMIN_ID) {
    const offsetStr = data.slice(GLOBAL_STORIES_CALLBACK_PREFIX.length);
    const offset = Number.parseInt(offsetStr, 10);
    if (Number.isNaN(offset)) {
      await ctx.answerCbQuery();
      return;
    }

    const message = ctx.callbackQuery.message as any;
    const chatId = String(message?.chat?.id ?? ctx.chat?.id ?? ctx.from.id);
    const user = ctx.from!;
    const task: UserInfo = {
      chatId,
      link: 'global',
      linkType: 'username',
      locale: user.language_code || 'en',
      user,
      initTime: Date.now(),
      storyRequestType: 'global',
      offset,
      globalStoriesMessageId: message?.message_id,
    };
    handleNewTask(task);
    await ctx.answerCbQuery();
    return;
  }

  if (data.includes('&')) {
    const isPremium = isUserPremium(String(ctx.from?.id));
    if (!isPremium) {
      const locale = ctx.from?.language_code || 'en';
      return ctx.answerCbQuery(t(locale, 'feature.requiresPremium'), { show_alert: true });
    }
    const [username, nextStoriesIds] = data.split('&');
    const user = ctx.from!;
    const task: UserInfo = {
      chatId: String(user.id),
      link: username,
      linkType: 'username',
      nextStoriesIds: nextStoriesIds ? JSON.parse(nextStoriesIds) : undefined,
      locale: user.language_code || '',
      user: user,
      initTime: Date.now(),
      isPremium: isPremium,
      storyRequestType: 'paginated',
      isPaginated: true,
    };
    handleNewTask(task);
    try {
      const message = ctx.callbackQuery.message as any;
      const markup = message?.reply_markup?.inline_keyboard;
      if (markup) {
        const newKeyboard = markup
          .map((row: any[]) =>
            row.filter((btn: any) => btn.callback_data !== data)
          )
          .filter((row: any[]) => row.length > 0);
        await ctx.editMessageReplyMarkup(
          newKeyboard.length ? { inline_keyboard: newKeyboard } : undefined
        );
        if (newKeyboard.length === 0) {
          try {
            await ctx.deleteMessage();
          } catch {
            /* ignore */
          }
        }
      } else {
        await ctx.editMessageReplyMarkup(undefined);
      }
    } catch (e) {
      console.error('Failed to update inline keyboard:', e);
    }
    await ctx.answerCbQuery();
  }
}

bot.on('callback_query', handleCallbackQuery);

// --- Handle all other text messages ---
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const locale = ctx.from.language_code || 'en';

  if (!isActivated(userId)) {
    const locale = ctx.from.language_code || 'en';
    return ctx.reply(t(locale, 'msg.botStart'), {
      reply_markup: {
        keyboard: [['/start']],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }

  if (userId == BOT_ADMIN_ID && text === RESTART_COMMAND) {
    return ctx.reply(t(locale, 'admin.confirmRestart'), {
        reply_markup: { inline_keyboard: [[{ text: t(locale, 'admin.restartButton'), callback_data: RESTART_COMMAND }]] },
    });
  }



  const isStoryLink = isValidStoryLink(text);
  const isUsername = text.startsWith('@') || text.startsWith('+');
  const looksLikeLink = /^https?:\/\//i.test(text) || text.includes('t.me/');

  if (isUsername || isStoryLink) {
    const isPremium = isUserPremium(String(userId));
    const user = ctx.from;
    const task: UserInfo = {
      chatId: String(ctx.chat.id),
      link: text,
      linkType: isStoryLink ? 'link' : 'username',
      locale: user.language_code || '',
      user: user,
      initTime: Date.now(),
      isPremium: isPremium,
    };
    handleNewTask(task);
    return;
  }

  if (looksLikeLink && userId !== BOT_ADMIN_ID) {
    const count = recordInvalidLink(String(userId));
    if (count >= 5) {
      suspendUserTemp(String(userId), 3600);
      await ctx.reply(t(locale, 'invalidLink.suspended'));
    } else {
      const left = 5 - count;
      await ctx.reply(t(locale, 'invalidLink.warning', { count: left }));
    }
    return;
  }

  await ctx.reply(t(locale, 'msg.invalidInput'), extraOptions);
});



// =============================
// BOT LAUNCH & QUEUE STARTUP
// =============================

async function startApp() {
  console.log('[App] Initializing...');
  resetStuckJobs();
  await initUserbot();
  // FIX: Clarified the log message for consistency.
  console.log('[App] Kicking off initial queue processing...');
  processQueue();
  startMonitorLoop();
  resumePendingChecks();
  scheduleDatabaseBackups();
  await bot.telegram.setMyCommands(getBaseCommands('en'));
  await bot.telegram.setMyCommands(
    [...getBaseCommands('en'), ...getPremiumCommands('en'), ...getAdminCommands('en')],
    { scope: { type: 'chat', chat_id: BOT_ADMIN_ID } }
  );
  bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log('✅ Telegram bot started successfully and is ready for commands.');
  });
}

if (process.env.NODE_ENV !== 'test') {
  startApp();
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
