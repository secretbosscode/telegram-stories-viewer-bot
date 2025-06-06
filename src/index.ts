// ===============================
//   Ghost Stories Bot Main Entry
//   CORE BOT LOGIC -- DO NOT REMOVE
// ===============================

/**
 * Imports -- PATH NOTES:
 * - All "config/..." and "services/..." are *relative to src/* (NOT root).
 * - "./repositories/user-repository" is used for user DB actions (ensure file exists!).
 * - If you restructure, adjust these paths accordingly (ex: src/repositories/user-repository.ts).
 */
import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { newTaskReceived } from 'services/stories-service';
import { session, Telegraf } from 'telegraf';
import { callbackQuery, message } from 'telegraf/filters';

import { db } from './db'; // <-- This must point to your SQLite db connection file!
import { isUserPremium, addPremiumUser, removePremiumUser } from 'services/premium-service';
// CRUCIAL: This must point to your user repository logic. Adjust the relative path if you move files!
import { saveUser } from './repositories/user-repository';

export const bot = new Telegraf<IContextBot>(BOT_TOKEN);
const RESTART_COMMAND = 'restart';

// =======================
// Middleware and Error Handling
// =======================
bot.use(session());
bot.catch((error) => {
  // DO NOT REMOVE: This logs any unhandled bot errors for debugging!
  console.error(error, 'INDEX.TS');
});

// Disables Telegram link previews for all replies
const extraOptions: any = {
  link_preview_options: {
    is_disabled: true,
  },
};

// =========================
//    DB/USER UTILITIES
// =========================

/**
 * Check if a user has started the bot (exists in DB)
 * Used to guard all commands and story functions.
 */
function userHasStarted(userId: string | number): boolean {
  // User table must have telegram_id column
  const found = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(userId.toString());
  return !!found;
}

/**
 * Block usage until user types /start and is in DB.
 * Use this in EVERY command handler except /start.
 */
async function guardUser(ctx: any) {
  await ctx.reply('👋 Please type /start to begin using the bot.');
}

// =============================
//         USER COMMANDS
// =============================

/**
 * /start
 * 1. Adds user to DB (if not already present).
 * 2. Shows instructions.
 * WARNING: This is the ONLY place users are added.
 * If you move/add logic for user registration, update all comments!
 */
bot.start(async (ctx) => {
  if (!userHasStarted(ctx.from.id)) {
    // Save user to the database. Don't duplicate!
    saveUser(ctx.from);
    await ctx.reply('👤 New user added to DB');
  }
  await ctx.reply(
    '🔗 Please send 1 of the next options:\n\n' +
      "username (with '@' symbol):\n@chupapee\n\n" +
      "or phone number (with '+' symbol):\n+71234567890\n\n" +
      'or the direct link to story:\nhttps://t.me/durov/s/1',
    extraOptions
  );
});

/**
 * /help - Lists available commands.
 * - Admins get extra commands in the list.
 * - Escaping is required for MarkdownV2 (see below).
 * - If you add more commands, add them here!
 */
bot.command('help', async (ctx) => {
  if (!userHasStarted(ctx.from.id)) {
    await guardUser(ctx);
    return;
  }
  let helpText =
    '🤖 *Ghost Stories Bot Help*\n\n' +
    'General Commands:\n' +
    '/start - Show usage instructions\n' +
    '/help - Show this help message\n' +
    '/premium - Info about premium (coming soon!)\n';

  if (ctx.from.id === BOT_ADMIN_ID) {
    helpText +=
      '\n*Admin Commands:*\n' +
      '/setpremium <telegram_id | @username> - Mark user as premium\n' +
      '/unsetpremium <telegram_id | @username> - Remove premium status\n' +
      '/ispremium <telegram_id | @username> - Check if user is premium\n' +
      '/listpremium - List all premium users\n' +
      '/users - List all users\n' +
      '/restart - (text only) Restart the bot\n';
  }
  // Escape MarkdownV2 symbols
  helpText = helpText.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
  await ctx.reply(helpText, { parse_mode: 'MarkdownV2' });
});

/**
 * /premium - Placeholder/info for premium users.
 * This is for roadmap/marketing/monetization info.
 */
bot.command('premium', async (ctx) => {
  if (!userHasStarted(ctx.from.id)) {
    await guardUser(ctx);
    return;
  }
  await ctx.reply(
    '🌟 Premium coming soon!\nPremium users will get unlimited access, story queue priority, and more.\n\nFor early access, ask the admin.'
  );
});

// =============================
//   MAIN STORY INPUT HANDLER
//   DO NOT TOUCH UNLESS YOU 
//   NEED TO CHANGE USER INPUT
// =============================

bot.on(message('text'), async (ctx) => {
  // Only process if user is registered
  if (!userHasStarted(ctx.from.id)) {
    await guardUser(ctx);
    return;
  }

  const text = ctx.message.text;
  console.log('Received text:', text, 'from:', ctx.from?.id);

  // Username/phone input
  if (text.startsWith('@') || text.startsWith('+')) {
    await newTaskReceived({
      chatId: String(ctx.chat.id),
      link: text,
      linkType: 'username',
      locale: '',
      user: ctx.from,
      initTime: Date.now(),
    });
    return;
  }
  // Telegram "story" link input
  if (text.startsWith('https') || text.startsWith('t.me/')) {
    const paths = text.split('/');
    if (
      !Number.isNaN(Number(paths.at(-1))) &&
      paths.at(-2) === 's' &&
      paths.at(-3)
    ) {
      await newTaskReceived({
        chatId: String(ctx.chat.id),
        link: text,
        linkType: 'link',
        locale: '',
        user: ctx.from,
        initTime: Date.now(),
      });
      return;
    }
  }
  // Admin: /restart confirmation
  if (ctx.from.id === BOT_ADMIN_ID && ctx.message.text === RESTART_COMMAND) {
    await ctx.reply('Are you sure?', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Yes', callback_data: RESTART_COMMAND }]],
      },
    });
    return;
  }
  // All other text is invalid!
  await ctx.reply(
    '🚫 Invalid command or input.\nType /help for available commands or /start to begin.'
  );
});

// =============================
//     CALLBACK HANDLERS
// =============================

bot.on(callbackQuery('data'), async (ctx) => {
  if (!userHasStarted(ctx.from.id)) {
    await guardUser(ctx);
    return;
  }
  // Pagination for story viewing
  if (ctx.callbackQuery.data.includes('&')) {
    const [username, nextStoriesIds] = ctx.callbackQuery.data.split('&');
    await newTaskReceived({
      chatId: String(ctx?.from?.id),
      link: username,
      linkType: 'username',
      nextStoriesIds: nextStoriesIds ? JSON.parse(nextStoriesIds) : undefined,
      locale: '',
      user: ctx.from,
      initTime: Date.now(),
    });
  }
  // Admin: restart action
  if (
    ctx.callbackQuery.data === RESTART_COMMAND &&
    ctx?.from?.id === BOT_ADMIN_ID
  ) {
    await ctx.answerCbQuery('⏳ Restarting...');
    process.exit();
  }
});

// =============================
//         ADMIN COMMANDS
//     DO NOT TOUCH DB LOGIC
// =============================

/**
 * /setpremium <telegram_id | @username>
 * - Only callable by admin.
 * - Safely gets ID from username if needed.
 */
bot.command('setpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) {
    await ctx.reply('🚫 You are not authorized to use this command.');
    return;
  }
  if (!userHasStarted(ctx.from.id)) {
    await guardUser(ctx);
    return;
  }
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) {
    await ctx.reply('Usage: /setpremium <telegram_id | @username>');
    return;
  }
  let telegramId: string | undefined;
  let username: string | undefined;

  if (args[0].startsWith('@')) {
    username = args[0].replace('@', '');
    const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(username) as { telegram_id?: string } | undefined;
    if (!row || !row.telegram_id) {
      await ctx.reply('User not found in database.');
      return;
    }
    telegramId = row.telegram_id;
  } else if (/^\d+$/.test(args[0])) {
    telegramId = args[0];
  } else {
    await ctx.reply('Invalid argument. Provide a Telegram user ID or @username.');
    return;
  }
  if (!telegramId) {
    await ctx.reply('Could not resolve telegram ID.');
    return;
  }
  addPremiumUser(telegramId, username);
  await ctx.reply(`✅ User ${username ? '@'+username : telegramId} marked as premium!`);
});

/**
 * /unsetpremium <telegram_id | @username>
 */
bot.command('unsetpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) {
    await ctx.reply('🚫 You are not authorized to use this command.');
    return;
  }
  if (!userHasStarted(ctx.from.id)) {
    await guardUser(ctx);
    return;
  }
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) {
    await ctx.reply('Usage: /unsetpremium <telegram_id | @username>');
    return;
  }
  let telegramId: string | undefined;
  let username: string | undefined;

  if (args[0].startsWith('@')) {
    username = args[0].replace('@', '');
    const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(username) as { telegram_id?: string } | undefined;
    if (!row || !row.telegram_id) {
      await ctx.reply('User not found in database.');
      return;
    }
    telegramId = row.telegram_id;
  } else if (/^\d+$/.test(args[0])) {
    telegramId = args[0];
  } else {
    await ctx.reply('Invalid argument. Provide a Telegram user ID or @username.');
    return;
  }
  if (!telegramId) {
    await ctx.reply('Could not resolve telegram ID.');
    return;
  }
  removePremiumUser(telegramId);
  await ctx.reply(`✅ User ${username ? '@'+username : telegramId} is no longer premium.`);
});

/**
 * /ispremium <telegram_id | @username>
 */
bot.command('ispremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) {
    await ctx.reply('🚫 You are not authorized to use this command.');
    return;
  }
  if (!userHasStarted(ctx.from.id)) {
    await guardUser(ctx);
    return;
  }
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) {
    await ctx.reply('Usage: /ispremium <telegram_id | @username>');
    return;
  }
  let telegramId: string | undefined;
  let username: string | undefined;

  if (args[0].startsWith('@')) {
    username = args[0].replace('@', '');
    const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(username) as { telegram_id?: string } | undefined;
    if (!row || !row.telegram_id) {
      await ctx.reply('User not found in database.');
      return;
    }
    telegramId = row.telegram_id;
  } else if (/^\d+$/.test(args[0])) {
    telegramId = args[0];
  } else {
    await ctx.reply('Invalid argument. Provide a Telegram user ID or @username.');
    return;
  }
  if (!telegramId) {
    await ctx.reply('Could not resolve telegram ID.');
    return;
  }
  const premium = isUserPremium(telegramId);
  await ctx.reply(
    premium
      ? `✅ User ${username ? '@'+username : telegramId} is PREMIUM.`
      : `❌ User ${username ? '@'+username : telegramId} is NOT premium.`
  );
});

/**
 * /listpremium
 * - Lists all premium users in DB
 */
bot.command('listpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) {
    await ctx.reply('🚫 You are not authorized to use this command.');
    return;
  }
  if (!userHasStarted(ctx.from.id)) {
    await guardUser(ctx);
    return;
  }
  const rows = db.prepare('SELECT telegram_id, username FROM users WHERE is_premium = 1').all() as { telegram_id: string, username?: string }[];
  if (!rows.length) {
    await ctx.reply('No premium users found.');
    return;
  }
  let msg = `🌟 Premium users (${rows.length}):\n`;
  rows.forEach((u, i) => {
    msg += `${i + 1}. ${u.username ? '@'+u.username : u.telegram_id}\n`;
  });
  await ctx.reply(msg);
});

/**
 * /users
 * - Lists ALL users (admin only)
 */
bot.command('users', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) {
    await ctx.reply('🚫 You are not authorized to use this command.');
    return;
  }
  if (!userHasStarted(ctx.from.id)) {
    await guardUser(ctx);
    return;
  }
  const rows = db.prepare('SELECT telegram_id, username, is_premium FROM users').all() as { telegram_id: string, username?: string, is_premium?: number }[];
  if (!rows.length) {
    await ctx.reply('No users found.');
    return;
  }
  let msg = `👥 Users (${rows.length}):\n`;
  rows.forEach((u, i) => {
    msg += `${i + 1}. ${u.username ? '@'+u.username : u.telegram_id} [${u.is_premium ? 'PREMIUM' : 'FREE'}]\n`;
  });
  await ctx.reply(msg);
});

// =============================
//     BOT LAUNCH/SHUTDOWN
// =============================

bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('Telegram bot started.');
});
initUserbot();

// =============================
//     PROCESS SIGNAL HANDLING
//   DO NOT REMOVE THESE BLOCKS
// =============================

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('Unhandled Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
