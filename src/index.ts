// =============================
//  Ghost Stories Bot Main Entry
// =============================

import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { newTaskReceived, UserInfo } from 'services/stories-service';
import { session, Telegraf } from 'telegraf';
import { db } from './db';

import { isUserPremium, addPremiumUser, removePremiumUser } from './services/premium-service';
import { saveUser, userHasStarted, findUserById } from './repositories/user-repository';

export const bot = new Telegraf<IContextBot>(BOT_TOKEN);
const RESTART_COMMAND = 'restart';

// --- Middleware ---
bot.use(session());
bot.catch((error, ctx) => {
  console.error(`A global error occurred for chat ${ctx.chat?.id}:`, error);
  ctx.reply('Sorry, an unexpected error occurred. Please try again later.').catch(() => {});
});

const extraOptions: any = { link_preview_options: { is_disabled: true } };

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
// CRITICAL NOTE: Handler order is essential in Telegraf.
// The structure below registers specific command handlers (`.command()`) first,
// followed by specific event handlers (`.on('callback_query')`), and finally the
// general-purpose text handler (`.on('text')`).
//
// DO NOT CHANGE THIS ORDER without understanding Telegraf's middleware flow,
// as it can cause commands or buttons to become unresponsive.
// =========================================================================


// --- Step 1: Handle all specific slash commands ---

bot.start(async (ctx) => {
  saveUser(ctx.from);
  await ctx.reply(
    '🔗 Please send one of the following:\n\n' +
      "*Username with '@' symbol:*\n`@durov`\n\n" +
      "*Phone number with '+' symbol:*\n`+15551234567`\n\n" +
      '*Direct link to a story:*\n`https://t.me/durov/s/1`',
    { ...extraOptions, parse_mode: 'Markdown' }
  );
});

bot.command('help', async (ctx) => {
  let finalHelpText =
    '*Ghost Stories Bot Help*\n\n' +
    '*General Commands:*\n' +
    '`/start` \\- Show usage instructions\n' +
    '`/help` \\- Show this help message\n' +
    '`/premium` \\- Info about premium features\n';

  if (ctx.from.id === BOT_ADMIN_ID) {
    finalHelpText +=
      '\n*Admin Commands:*\n' +
      '`/setpremium <ID or @username>` \\- Mark user as premium\n' +
      '`/unsetpremium <ID or @username>` \\- Remove premium status\n' +
      '`/ispremium <ID or @username>` \\- Check if user is premium\n' +
      '`/listpremium` \\- List all premium users\n' +
      '`/users` \\- List all users\n' +
      '`/restart` \\- Shows the restart confirmation button\n';
  }
  await ctx.reply(finalHelpText, { parse_mode: 'MarkdownV2' });
});

bot.command('premium', async (ctx) => {
  await ctx.reply(
    '🌟 *Premium Access*\n\n' +
    'Premium users get:\n' +
    '✅ Unlimited story downloads\n' +
    '✅ No cooldowns or waiting in queues\n\n' +
    'Payments and subscriptions are coming soon\\!',
    { parse_mode: 'MarkdownV2' }
  );
});

// --- Admin Commands ---

bot.command('restart', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  await ctx.reply('Are you sure you want to restart?', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Yes, Restart', callback_data: RESTART_COMMAND }]],
    },
  });
});

bot.command('setpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply('Usage: /setpremium <telegram_id | @username>');
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
    addPremiumUser(telegramId, username);
    await ctx.reply(`✅ User ${username ? '@'+username : telegramId} marked as premium!`);
  } catch (e) { console.error("Error in /setpremium:", e); await ctx.reply("An error occurred."); }
});

bot.command('unsetpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
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
  if (ctx.from.id !== BOT_ADMIN_ID) return;
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
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  try {
    const rows = db.prepare('SELECT telegram_id, username FROM users WHERE is_premium = 1').all() as any[];
    if (!rows.length) return ctx.reply('No premium users found.');
    let msg = `🌟 Premium users (${rows.length}):\n`;
    rows.forEach((u, i) => { msg += `${i + 1}. ${u.username ? '@'+u.username : u.telegram_id}\n`; });
    await ctx.reply(msg);
  } catch (e) { console.error("Error in /listpremium:", e); await ctx.reply("An error occurred."); }
});

bot.command('users', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please type /start first.');
  try {
    const rows = db.prepare('SELECT telegram_id, username, is_premium FROM users').all() as any[];
    if (!rows.length) return ctx.reply('No users found in the database.');
    let msg = `👥 Users (${rows.length}):\n`;
    rows.forEach((u, i) => { msg += `${i + 1}. ${u.username ? '@'+u.username : u.telegram_id} [${u.is_premium ? 'PREMIUM' : 'FREE'}]\n`; });
    await ctx.reply(msg);
  } catch (e) { console.error("Error in /users:", e); await ctx.reply("An error occurred."); }
});


// --- Step 2: Handle specific events like button presses ---

bot.on('callback_query', async (ctx) => {
  if (!('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  if (data === RESTART_COMMAND && ctx.from.id === BOT_ADMIN_ID) {
    await ctx.answerCbQuery('⏳ Restarting server...');
    process.exit();
  }

  if (data.includes('&')) {
    const isPremium = isUserPremium(String(ctx.from.id));
    if (!isPremium) {
        return ctx.answerCbQuery('This feature requires Premium access.', { show_alert: true });
    }
    const [username, nextStoriesIds] = data.split('&');
    await newTaskReceived({
      chatId: String(ctx.from.id), link: username, linkType: 'username',
      nextStoriesIds: nextStoriesIds ? JSON.parse(nextStoriesIds) : undefined,
      locale: ctx.from.language_code || '', user: ctx.from, initTime: Date.now(), isPremium: isPremium,
    });
    await ctx.answerCbQuery();
  }
});


// --- Step 3: Handle all other text messages as a fallback ---

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  if (!isActivated(userId)) {
    return ctx.reply('👋 Please type /start to begin using the bot.');
  }

  // NOTE: Plain-text 'restart' is a special case handled here.
  if (userId === BOT_ADMIN_ID && text === RESTART_COMMAND) {
    return ctx.reply('Are you sure you want to restart?', {
      reply_markup: { inline_keyboard: [[{ text: 'Yes, Restart', callback_data: RESTART_COMMAND }]] },
    });
  }

  const isStoryLink = text.startsWith('https') || text.startsWith('t.me/');
  const isUsername = text.startsWith('@') || text.startsWith('+');

  if (isUsername || isStoryLink) {
    const isPremium = isUserPremium(String(userId));
    await newTaskReceived({
      chatId: String(ctx.chat.id), link: text, linkType: isStoryLink ? 'link' : 'username',
      locale: ctx.from.language_code || '', user: ctx.from, initTime: Date.now(), isPremium: isPremium,
    });
    return;
  }

  // If the text was not a command (handled above) and not a valid story request format, send this fallback.
  await ctx.reply('🚫 Invalid input. Send a username like `@durov` or a story link. Type /help for more info.');
});


// =============================
// BOT LAUNCH/SHUTDOWN
// =============================

bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('✅ Telegram bot started.');
});
initUserbot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
process.on('uncaughtException', (err) => { console.error('Unhandled Exception:', err); });
process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection at:', promise, 'reason:', reason); });
