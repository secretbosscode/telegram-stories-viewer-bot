// src/index.ts

// Global error handlers must be at the absolute top.
process.on('unhandledRejection', (reason, promise) => { console.error('CRITICAL_ERROR: Unhandled Rejection at:', promise, 'reason:', reason); });
process.on('uncaughtException', (error, origin) => { console.error('CRITICAL_ERROR: Uncaught Exception:', error, 'origin:', origin); });
console.log('Global error handlers have been attached.');

// Redirect console output to a debug log file for easier troubleshooting
import './config/setup-logs';

import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN, LOG_FILE } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { session, Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';
import {
  db,
  resetStuckJobs,
  updateFromAddress,
  blockUser,
  unblockUser,
  isUserBlocked,
  listBlockedUsers,
  getInvoice,
} from './db';
import { getRecentHistoryFx } from './db/effects';
import { processQueue, handleNewTask, getQueueStatusForUser } from './services/queue-manager';
import { saveUser } from './repositories/user-repository';
import {
  isUserPremium,
  addPremiumUser,
  removePremiumUser,
  extendPremium,
  getPremiumDaysLeft,
  grantFreeTrial,
  hasUsedFreeTrial,
} from './services/premium-service';
import {
  addProfileMonitor,
  removeProfileMonitor,
  userMonitorCount,
  listUserMonitors,
  startMonitorLoop,
  CHECK_INTERVAL_HOURS,
  MAX_MONITORS_PER_USER,
} from './services/monitor-service';
import {
  schedulePaymentCheck,
  resumePendingChecks,
  setBotInstance,
  verifyPaymentByTxid,
} from './services/btc-payment';
import { handleUpgrade } from 'controllers/upgrade';
import { handlePremium } from 'controllers/premium';
import { UserInfo } from 'types';
import { sendTemporaryMessage } from 'lib';

export const bot = new Telegraf<IContextBot>(BOT_TOKEN!);
setBotInstance(bot);
const RESTART_COMMAND = 'restart';
const extraOptions: any = { link_preview_options: { is_disabled: true } };

const logPath = LOG_FILE;
const logDir = path.dirname(logPath);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

bot.use(session());
bot.use(async (ctx, next) => {
  if (ctx.from?.is_bot) {
    if (ctx.from.id) {
      blockUser(String(ctx.from.id));
    }
    return;
  }
  if (ctx.from && isUserBlocked(String(ctx.from.id))) {
    return;
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
  ctx
    .reply('Sorry, an unexpected error occurred. Please try again later.')
    .catch(() => {});
});

bot.use(async (ctx, next) => {
  await next();
  try {
    const id = ctx.from?.id;
    if (!id) return;
    const text =
      ctx.updateType === 'message' && ctx.message && 'text' in ctx.message
        ? ctx.message.text
        : '';
    if (text.startsWith('/premium')) return;
    if (isUserPremium(String(id))) {
      const days = getPremiumDaysLeft(String(id));
      const daysText = days === Infinity ? 'unlimited' : days.toString();
      await sendTemporaryMessage(
        bot,
        ctx.chat!.id,
        `You have ${daysText} day${days === 1 ? '' : 's'} of Premium left.`
      ).catch(() => {});
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
  let msg =
    "🔗 Please send one of the following:\n\n" +
    "*Username with '@' symbol:*\n`@durov`\n\n" +
    "*Phone number with '+' symbol:*\n`+19875551234`\n\n" +
    '*Direct link to a story:*\n`https://t.me/durov/s/1`';
  if (!isUserPremium(String(ctx.from.id)) && !hasUsedFreeTrial(String(ctx.from.id))) {
    msg =
      '🎁 New here? Use /freetrial to get 7 days of Premium access for free!\n\n' +
      msg;
  }
  await ctx.reply(msg, { ...extraOptions, parse_mode: 'Markdown' });
});

bot.command('help', async (ctx) => {
  let finalHelpText =
    '*Ghost Stories Bot Help*\n\n' +
    '*General Commands:*\n' +
    '`/start` - Show usage instructions\n' +
    '`/help` - Show this help message\n' +
    '`/premium` - Info about premium features\n' +
    '`/freetrial` - Get 7 days of Premium access\n' +
    '`/queue` - View your place in the download queue\n' +
    '`/verify <txid> <invoice>` - Manually verify a payment if it is not detected\n';

  const isAdmin = ctx.from.id === BOT_ADMIN_ID;
  const isPremium = isUserPremium(String(ctx.from.id));
  if (isPremium || isAdmin) {
    finalHelpText +=
      '\n*Premium Commands:*\n' +
      '`/monitor` - Monitor a profile for new stories\n' +
      '  Use @username or a phone number like +19875551234 (no hyphens)\n' +
      '`/unmonitor` - Stop monitoring a profile\n';
  }

  if (ctx.from.id == BOT_ADMIN_ID) {
    finalHelpText +=
      '\n*Admin Commands:*\n' +
      '`/setpremium <ID or @username> [days]` - Mark user as premium (0 = never expires)\n' +
      '`/unsetpremium <ID or @username>` - Remove premium status\n' +
      '`/ispremium <ID or @username>` - Check if user is premium\n' +
      '`/listpremium` - List all premium users\n' +
      '`/users` - List all users\n' +
      '`/history` - Recent user activity\n' +
      '`/block <ID or @username>` - Block a user\n' +
      '`/unblock <ID or @username>` - Unblock a user\n' +
      '`/blocklist` - List blocked users\n' +
      '`/restart` - Shows the restart confirmation button\n';
  }
  finalHelpText +=
    '\nTo find the transaction ID (txid), check the details of your payment in your wallet.';
  // Using 'Markdown' as it's more forgiving than 'MarkdownV2' for simple text.
  await ctx.reply(finalHelpText, { parse_mode: 'Markdown' });
});

bot.command('premium', handlePremium);

bot.command('upgrade', async (ctx) => {
  await handleUpgrade(ctx);
});

bot.command('freetrial', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!isActivated(ctx.from.id)) return ctx.reply('Please type /start first.');
  if (isUserPremium(userId)) {
    return ctx.reply('✅ You already have Premium access.');
  }
  if (hasUsedFreeTrial(userId)) {
    return ctx.reply('❌ You have already used your free trial.');
  }
  grantFreeTrial(userId);
  await ctx.reply('🎉 Free trial activated! You now have Premium access for 7 days.');
});

bot.command('verify', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    if (isUserPremium(String(ctx.from.id))) {
      return ctx.reply('✅ You already have Premium access.');
    }
    return ctx.reply('Usage: /verify <txid> <invoice_id>');
  }
  const [txid, invoiceIdStr] = args;
  const invoiceId = parseInt(invoiceIdStr, 10);
  if (!txid || !invoiceId) return ctx.reply('Invalid arguments.');
  const existing = getInvoice(invoiceId);
  if (existing && existing.paid_at) {
    return ctx.reply('✅ This invoice has already been verified.');
  }
  const invoice = await verifyPaymentByTxid(invoiceId, txid);
  if (invoice && invoice.paid_at) {
    extendPremium(String(ctx.from.id), 30);
    return ctx.reply('✅ Payment verified! Premium extended by 30 days.');
  }
  await ctx.reply('❌ Unable to verify this transaction.');
});

bot.command('queue', async (ctx) => {
  if (!isActivated(ctx.from.id)) return ctx.reply('Please type /start first.');
  const msg = await getQueueStatusForUser(String(ctx.from.id));
  await sendTemporaryMessage(bot, ctx.chat!.id, msg);
});

bot.command('monitor', async (ctx) => {
  const userId = String(ctx.from.id);
  const isAdmin = ctx.from.id === BOT_ADMIN_ID;
  const isPremium = isUserPremium(userId);
  if (!isAdmin && !isPremium) {
    return ctx.reply('🚫 Monitoring profiles is available for premium users.');
  }
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) {
    const list = listUserMonitors(userId);
    if (list.length === 0) {
      const limitMsg = isAdmin
        ? 'You can monitor an unlimited number of profiles. '
        : `You can monitor up to ${MAX_MONITORS_PER_USER} profiles. `;
      return ctx.reply(
        `Usage: /monitor <@username|+19875551234>\n` +
          limitMsg +
          `Checks run every ${CHECK_INTERVAL_HOURS}h.`
      );
    }
    const limit = isAdmin ? '∞' : MAX_MONITORS_PER_USER;
    const msg =
      `👀 Currently monitoring (${list.length}/${limit}):\n` +
      list.map((m, i) => `${i + 1}. @${m.target_username}`).join('\n') +
      `\nChecks run every ${CHECK_INTERVAL_HOURS}h. ` +
      'Use /unmonitor <@username> to remove.';
    return ctx.reply(msg);
  }
  const input = args[0];
  const username = input.replace(/^@/, '');
  if (!isAdmin) {
    if (userMonitorCount(userId) >= MAX_MONITORS_PER_USER) {
      return ctx.reply(`🚫 You can monitor up to ${MAX_MONITORS_PER_USER} profiles.`);
    }
  }
  addProfileMonitor(userId, username);
  const currentCount = userMonitorCount(userId);
  const remainingText = isAdmin
    ? 'You can monitor unlimited profiles.'
    : `You have ${Math.max(
        MAX_MONITORS_PER_USER - currentCount,
        0
      )} monitor${
        MAX_MONITORS_PER_USER - currentCount === 1 ? '' : 's'
      } left.`;
  await ctx.reply(
    `✅ Now monitoring ${input} for active stories. ${remainingText}`
  );
});

bot.command('unmonitor', async (ctx) => {
  const userId = String(ctx.from.id);
  const isAdmin = ctx.from.id === BOT_ADMIN_ID;
  const isPremium = isUserPremium(userId);
  if (!isAdmin && !isPremium) {
    return ctx.reply('🚫 Monitoring profiles is available for premium users.');
  }
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) {
    const list = listUserMonitors(userId);
    if (list.length === 0) {
      return ctx.reply('You are not monitoring any profiles.');
    }
    const msg =
      '👀 Currently monitoring:\n' +
      list.map((m, i) => `${i + 1}. @${m.target_username}`).join('\n');
    return ctx.reply(msg);
  }
  const inputUn = args[0];
  const username = inputUn.replace(/^@/, '');
  removeProfileMonitor(userId, username);
  await ctx.reply(`🛑 Stopped monitoring ${inputUn}.`);
});

// --- Admin Commands ---

bot.command('restart', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  await ctx.reply('Are you sure you want to restart?', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Yes, Restart', callback_data: RESTART_COMMAND }]],
    },
  });
});

// FIX: Restored full implementation for all admin commands.
bot.command('setpremium', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply('Usage: /setpremium <telegram_id | @username> [days]');
    let telegramId: string | undefined, username: string | undefined;
    if (args[0].startsWith('@')) {
      username = args[0].replace('@', '');
      const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(username) as { telegram_id?: string };
      if (!row?.telegram_id) return ctx.reply('User not found in database.');
      telegramId = row.telegram_id;
    } else if (/^\d+$/.test(args[0])) {
      telegramId = args[0];
    } else { return ctx.reply('Invalid argument.'); }
    if (!telegramId) return ctx.reply('Could not resolve telegram ID.');
    const days = args[1] ? parseInt(args[1], 10) : undefined;
    addPremiumUser(telegramId, username, days);
    await ctx.reply(`✅ User ${username ? '@'+username : telegramId} marked as premium${days ? ' for ' + days + ' day(s)' : ''}!`);
  } catch (e) { console.error("Error in /setpremium:", e); await ctx.reply("An error occurred."); }
});

bot.command('unsetpremium', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply('Usage: /unsetpremium <telegram_id | @username>');
    let telegramId: string | undefined, username: string | undefined;
    if (args[0].startsWith('@')) {
      username = args[0].replace('@', '');
      const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(username) as { telegram_id?: string };
      if (!row?.telegram_id) return ctx.reply('User not found in database.');
      telegramId = row.telegram_id;
    } else if (/^\d+$/.test(args[0])) {
      telegramId = args[0];
    } else { return ctx.reply('Invalid argument.'); }
    if (!telegramId) return ctx.reply('Could not resolve telegram ID.');
    removePremiumUser(telegramId);
    await ctx.reply(`✅ User ${username ? '@'+username : telegramId} is no longer premium.`);
  } catch (e) { console.error("Error in /unsetpremium:", e); await ctx.reply("An error occurred."); }
});

bot.command('ispremium', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply('Usage: /ispremium <telegram_id | @username>');
    let telegramId: string | undefined, username: string | undefined;
    if (args[0].startsWith('@')) {
      username = args[0].replace('@', '');
      const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(username) as { telegram_id?: string };
      if (!row?.telegram_id) return ctx.reply('User not found in database.');
      telegramId = row.telegram_id;
    } else if (/^\d+$/.test(args[0])) {
      telegramId = args[0];
    } else { return ctx.reply('Invalid argument.'); }
    if (!telegramId) return ctx.reply('Could not resolve telegram ID.');
    const premium = isUserPremium(telegramId);
    await ctx.reply(premium ? `✅ User ${username ? '@'+username : telegramId} is PREMIUM.` : `❌ User ${username ? '@'+username : telegramId} is NOT premium.`);
  } catch (e) { console.error("Error in /ispremium:", e); await ctx.reply("An error occurred."); }
});

bot.command('listpremium', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  try {
    const rows = db.prepare('SELECT telegram_id, username FROM users WHERE is_premium = 1').all() as any[];
    if (!rows.length) return ctx.reply('No premium users found.');
    let msg = `🌟 Premium users (${rows.length}):\n`;
    rows.forEach((u, i) => {
      const days = getPremiumDaysLeft(String(u.telegram_id));
      const daysText = days === Infinity ? 'never expires' : `${days}d`;
      msg += `${i + 1}. ${u.username ? '@' + u.username : u.telegram_id} - ${daysText}\n`;
    });
    await ctx.reply(msg);
  } catch (e) { console.error("Error in /listpremium:", e); await ctx.reply("An error occurred."); }
});

bot.command('block', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply('Usage: /block <telegram_id | @username>');
    let telegramId: string | undefined;
    if (args[0].startsWith('@')) {
      const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(args[0].replace('@','')) as { telegram_id?: string };
      if (!row?.telegram_id) return ctx.reply('User not found in database.');
      telegramId = row.telegram_id;
    } else if (/^\d+$/.test(args[0])) {
      telegramId = args[0];
    } else { return ctx.reply('Invalid argument.'); }
    blockUser(telegramId!);
    await ctx.reply(`🚫 User ${telegramId} blocked.`);
  } catch (e) { console.error('Error in /block:', e); await ctx.reply('An error occurred.'); }
});

bot.command('unblock', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply('Usage: /unblock <telegram_id | @username>');
    let telegramId: string | undefined;
    if (args[0].startsWith('@')) {
      const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(args[0].replace('@','')) as { telegram_id?: string };
      if (!row?.telegram_id) return ctx.reply('User not found in database.');
      telegramId = row.telegram_id;
    } else if (/^\d+$/.test(args[0])) {
      telegramId = args[0];
    } else { return ctx.reply('Invalid argument.'); }
    unblockUser(telegramId!);
    await ctx.reply(`✅ User ${telegramId} unblocked.`);
  } catch (e) { console.error('Error in /unblock:', e); await ctx.reply('An error occurred.'); }
});

bot.command('blocklist', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  try {
    const rows = listBlockedUsers();
    if (!rows.length) return ctx.reply('No blocked users.');
    let msg = `🚫 Blocked users (${rows.length}):\n`;
    rows.forEach((u, i) => { msg += `${i + 1}. ${u.telegram_id} at ${new Date(u.blocked_at * 1000).toLocaleDateString()}\n`; });
    await ctx.reply(msg);
  } catch (e) { console.error('Error in /blocklist:', e); await ctx.reply('An error occurred.'); }
});

bot.command('users', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please type /start first.');
  try {
    const rows = db.prepare('SELECT telegram_id, username, is_premium FROM users').all() as any[];
    if (!rows.length) return ctx.reply('No users found in the database.');
    let msg = `👥 Users (${rows.length}):\n`;
    rows.forEach((u, i) => { msg += `${i + 1}. ${u.username ? '@'+u.username : u.telegram_id} [${u.is_premium ? 'PREMIUM' : 'FREE'}]\n`; });
    await ctx.reply(msg);
  } catch (e) { console.error("Error in /users:", e); await ctx.reply("An error occurred."); }
});

bot.command('history', async (ctx) => {
  if (ctx.from.id != BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please type /start first.');
  try {
    const rows = await getRecentHistoryFx(50);
    if (!rows.length) return ctx.reply('No recent history found.');
    let msg = `📜 History (last 30 days):\n`;
    rows.forEach((r: any, i: number) => {
      const date = new Date(r.enqueued_ts * 1000).toLocaleDateString();
      const user = r.username ? `@${r.username}` : r.telegram_id;
      msg += `${i + 1}. ${user} -> ${r.target_username} [${r.status}] ${date}\n`;
    });
    await ctx.reply(msg);
  } catch (e) {
    console.error('Error in /history:', e);
    await ctx.reply('An error occurred.');
  }
});

// --- Handle button presses ---
export async function handleCallbackQuery(ctx: IContextBot) {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  if (data === RESTART_COMMAND && ctx.from?.id == BOT_ADMIN_ID) {
    await ctx.answerCbQuery('⏳ Restarting server...');
    process.exit();
  }

  if (data.includes('&')) {
    const isPremium = isUserPremium(String(ctx.from?.id));
    if (!isPremium) {
      return ctx.answerCbQuery('This feature requires Premium access.', { show_alert: true });
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

  if (!isActivated(userId)) {
    return ctx.reply('👋 Please type /start to begin using the bot.');
  }

  if (userId == BOT_ADMIN_ID && text === RESTART_COMMAND) {
    return ctx.reply('Are you sure you want to restart?', {
        reply_markup: { inline_keyboard: [[{ text: 'Yes, Restart', callback_data: RESTART_COMMAND }]] },
    });
  }

  const upgradeState = ctx.session?.upgrade;
  if (upgradeState && !upgradeState.fromAddress) {
    if (Date.now() > upgradeState.awaitingAddressUntil) {
      ctx.session.upgrade = undefined;
      await ctx.reply('❌ Invoice expired.');
      return;
    }
    upgradeState.fromAddress = text.trim();
    upgradeState.checkStart = Date.now();
    updateFromAddress(upgradeState.invoice.id, upgradeState.fromAddress);
    await ctx.reply('Address received. Monitoring for payment...');
    schedulePaymentCheck(ctx);
    return;
  }

  const isStoryLink = text.startsWith('https') || text.startsWith('t.me/');
  const isUsername = text.startsWith('@') || text.startsWith('+');

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

  await ctx.reply('🚫 Invalid input. Send `@username`, `+19875551234` or a story link. Type /help for more info.');
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
  const commonCommands = [
    { command: 'start', description: 'Show usage instructions' },
    { command: 'help', description: 'Show help message' },
    { command: 'premium', description: 'Info about premium features' },
    { command: 'upgrade', description: 'Upgrade to premium' },
    { command: 'freetrial', description: 'Free 7-day premium trial' },
    { command: 'verify', description: 'Manually verify a payment' },
    { command: 'queue', description: 'Show your queue status' },
    { command: 'monitor', description: 'Monitor a profile for new stories' },
    { command: 'unmonitor', description: 'Stop monitoring a profile' },
  ];
  await bot.telegram.setMyCommands(commonCommands);
  await bot.telegram.setMyCommands(
    [...commonCommands, { command: 'restart', description: 'Restart the bot (admin)' }],
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
