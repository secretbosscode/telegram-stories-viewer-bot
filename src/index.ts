// ===============================
//   Ghost Stories Bot Entry Point
// ===============================

import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { newTaskReceived } from 'services/stories-service';
import { session, Telegraf } from 'telegraf';
import { callbackQuery, message } from 'telegraf/filters';

import { db } from './db';
import { isUserPremium, addPremiumUser, removePremiumUser } from 'services/premium-service';
import { saveUser, userHasStarted } from 'repositories/user-repository'; // <--- Fix path if needed

export const bot = new Telegraf<IContextBot>(BOT_TOKEN);
const RESTART_COMMAND = 'restart';

// --------------------------------
//       Middleware and Handlers
// --------------------------------

bot.use(session());

bot.catch((error) => {
  // Core global error handler, don't remove
  console.error(error, 'INDEX.TS');
});

// Disables link previews for all bot replies
const extraOptions: any = {
  link_preview_options: {
    is_disabled: true,
  },
};

// =============================
//   UTILITY: Command checker
// =============================

// Only allow users who have used /start, except /start, /help, /premium
bot.use(async (ctx, next) => {
  const allowedCommands = ['/start', '/help', '/premium'];
  const isCommand = ctx.message && ctx.message.text && ctx.message.text.startsWith('/');
  const userId = ctx.from?.id?.toString();
  if (!userId) return;
  if (isCommand) {
    const cmd = ctx.message.text.split(' ')[0].toLowerCase();
    if (allowedCommands.includes(cmd)) {
      await next();
      return;
    }
    // Only proceed if user is registered
    if (userHasStarted(userId)) {
      await next();
      return;
    }
    // Otherwise, tell them to /start
    await ctx.reply("👋 Please type /start to begin using the bot.");
    return;
  } else {
    // Not a command: Only proceed if registered
    if (userHasStarted(userId)) {
      await next();
      return;
    }
    await ctx.reply("👋 Please type /start to begin using the bot.");
    return;
  }
});

// =============================
//         USER COMMANDS
// =============================

/**
 * /start - Register user and show usage.
 */
bot.start(async (ctx) => {
  // Register user if not already done
  saveUser(ctx.from);

  await ctx.reply(
    '🔗 Please send 1 of the next options:\n\n' +
      "username (with '@' symbol):\n@chupapee\n\n" +
      "or phone number (with '+' symbol):\n+71234567890\n\n" +
      'or the direct link to story:\nhttps://t.me/durov/s/1',
    extraOptions
  );
  console.log(`[BOT] User ${ctx.from.id} started the bot.`);
});

/**
 * /help - List available commands.
 */
bot.command('help', async (ctx) => {
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

  // MarkdownV2: escape
  helpText = helpText
    .replace(/\./g, '\\.')
    .replace(/\-/g, '\\-')
    .replace(/\*/g, '\\*')
    .replace(/\_/g, '\\_')
    .replace(/\!/g, '\\!')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\~/g, '\\~')
    .replace(/\`/g, '\\`')
    .replace(/\>/g, '\\>')
    .replace(/\#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/\=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');

  await ctx.reply(helpText, { parse_mode: 'MarkdownV2' });
  console.log(`[BOT] /help called by ${ctx.from.id}`);
});

/**
 * /premium - Show info about premium (coming soon).
 */
bot.command('premium', async (ctx) => {
  await ctx.reply('🌟 Premium coming soon!\nPremium users will get unlimited access and more features.\nStay tuned!');
  console.log(`[BOT] /premium called by ${ctx.from.id}`);
});

// =============================
//    STORY PROCESSING SECTION
// =============================

bot.on(message('text'), async (ctx) => {
  // Only process for registered users
  const userId = ctx.from?.id?.toString();
  if (!userHasStarted(userId)) return;

  const text = ctx.message.text;
  console.log('Received text:', text, 'from:', ctx.from?.id);

  // [Core functionality] Handle username or phone number search
  if (text.startsWith('@') || text.startsWith('+')) {
    console.log('Processing username/phone:', text);
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

  // [Core functionality] Handle story links
  if (text.startsWith('https') || text.startsWith('t.me/')) {
    const paths = text.split('/');
    if (
      !Number.isNaN(Number(paths.at(-1))) &&
      paths.at(-2) === 's' &&
      paths.at(-3)
    ) {
      console.log('Processing link:', text);
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

  // [Core functionality] Handle /restart confirmation
  if (ctx.from.id === BOT_ADMIN_ID && ctx.message.text === RESTART_COMMAND) {
    await ctx.reply('Are you sure?', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Yes', callback_data: RESTART_COMMAND }]],
      },
    });
    return;
  }

  // [Default] For all other text input not matching above
  await ctx.reply('🚫 Invalid command or input.\nType /help for available commands or /start to begin.');
});

// =============================
//     CALLBACK HANDLERS
// =============================

bot.on(callbackQuery('data'), async (ctx) => {
  // [Pagination handler for stories]
  if (ctx.callbackQuery.data.includes('&')) {
    const [username, nextStoriesIds] = ctx.callbackQuery.data.split('&');
    console.log('Processing callback for pagination:', username, nextStoriesIds);

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

  // [Admin only] Confirmed restart
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
//     DO NOT TOUCH CORE DB LOGIC
// =============================

bot.command('setpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) {
    await ctx.reply('🚫 You are not authorized to use this command.');
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

bot.command('unsetpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) {
    await ctx.reply('🚫 You are not authorized to use this command.');
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

bot.command('ispremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) {
    await ctx.reply('🚫 You are not authorized to use this command.');
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

bot.command('listpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) {
    await ctx.reply('🚫 You are not authorized to use this command.');
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

bot.command('users', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) {
    await ctx.reply('🚫 You are not authorized to use this command.');
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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('Unhandled Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
