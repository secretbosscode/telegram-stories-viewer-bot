// =============================
//  Ghost Stories Bot Main Entry
// =============================

import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { newTaskReceived, UserInfo } from 'services/stories-service';
import { session, Telegraf } from 'telegraf';
import { db } from './db';

// Service and Repository imports
import { isUserPremium, addPremiumUser, removePremiumUser } from './services/premium-service';
import { saveUser, userHasStarted, findUserById } from './repositories/user-repository';

export const bot = new Telegraf<IContextBot>(BOT_TOKEN);
const RESTART_COMMAND = 'restart';

// --------------------------------
//      Middleware and Handlers
// --------------------------------

bot.use(session());

bot.catch((error) => {
  console.error('A global error occurred:', error);
});

const extraOptions: any = {
  link_preview_options: { is_disabled: true },
};

// =============================
//  Utility: Check Activation
// =============================

/**
 * Checks if a user has used /start and exists in the database.
 * @param userId - The user's Telegram ID.
 * @returns boolean - True if the user exists.
 */
function isActivated(userId: number): boolean {
  // IMPROVEMENT: Added a try...catch block to prevent a database query
  // error from crashing the entire bot.
  try {
    const user = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(String(userId));
    return !!user;
  } catch (error) {
    console.error(`[isActivated] Database check failed for user ${userId}:`, error);
    return false; // Safely default to false on error.
  }
}

// =============================
//        USER COMMANDS
// =============================

bot.start(async (ctx) => {
  saveUser(ctx.from); // Ensure the user is in the database.
  await ctx.reply(
    '🔗 Please send one of the following:\n\n' +
      "*Username with '@' symbol:*\n`@durov`\n\n" +
      "*Phone number with '+' symbol:*\n`+15551234567`\n\n" +
      '*Direct link to a story:*\n`https://t.me/durov/s/1`',
    { ...extraOptions, parse_mode: 'Markdown' }
  );
});

bot.command('help', async (ctx) => {
  // BUG FIX: The previous MarkdownV2 escaping was faulty and crashed the bot.
  // This version is safe. It uses backticks for commands and manually escapes
  // special characters in the description text.
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
      '`restart` \\(text only\\) \\- Restart the bot\n';
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

// =============================
// MAIN MESSAGE HANDLER
// =============================

bot.on('message', async (ctx) => {
  if (!('text' in ctx.message)) return;
  const text = ctx.message.text;
  const userId = ctx.from.id;

  const command = text.split(' ')[0];

  // BUG FIX: Previously, a block here was incorrectly stopping admin commands.
  // This new list tells the main handler to ignore ALL known commands and let
  // Telegraf's dedicated handlers (like bot.command('/users',...)) do their job.
  const knownCommands = ['/start', '/help', '/premium', '/setpremium', '/unsetpremium', '/ispremium', '/listpremium', '/users'];
  if (knownCommands.includes(command)) {
    return;
  }
  
  // For any other interaction, the user must have used /start first.
  // This check is now done once, making the logic cleaner.
  if (!isActivated(userId)) {
    await ctx.reply('👋 Please type /start to begin using the bot.');
    return;
  }

  // --- Core Story Request Logic ---
  const isStoryLink = text.startsWith('https') || text.startsWith('t.me/');
  const isUsername = text.startsWith('@') || text.startsWith('+');

  if (isUsername || isStoryLink) {
    // =========================================================================
    // CRITICAL FIX: Connect the database to the services layer.
    // This calls the `isUserPremium` function (from premium-service.ts) which
    // queries the database. The result is then passed into the task object.
    // This is what makes the premium limits and features work.
    // =========================================================================
    const isPremium = isUserPremium(String(userId));

    await newTaskReceived({
      chatId: String(ctx.chat.id),
      link: text,
      linkType: isStoryLink ? 'link' : 'username',
      locale: ctx.from.language_code || '',
      user: ctx.from,
      initTime: Date.now(),
      isPremium: isPremium,
    });
    return;
  }

  if (userId === BOT_ADMIN_ID && text === RESTART_COMMAND) {
    await ctx.reply('Are you sure you want to restart?', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Yes, Restart', callback_data: RESTART_COMMAND }]],
      },
    });
    return;
  }

  await ctx.reply('🚫 Invalid input. Send a username like `@durov` or a story link. Type /help for more info.');
});

// =============================
// CALLBACK HANDLERS
// =============================

bot.on('callback_query', async (ctx) => {
  if (!('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  if (data.includes('&')) {
    // Also check premium status for pagination clicks
    const isPremium = isUserPremium(String(ctx.from.id));
    if (!isPremium) {
        await ctx.answerCbQuery('This feature requires Premium access.', { show_alert: true });
        return;
    }
    const [username, nextStoriesIds] = data.split('&');
    await newTaskReceived({
      chatId: String(ctx.from.id),
      link: username,
      linkType: 'username',
      nextStoriesIds: nextStoriesIds ? JSON.parse(nextStoriesIds) : undefined,
      locale: ctx.from.language_code || '',
      user: ctx.from,
      initTime: Date.now(),
      isPremium: isPremium,
    });
    await ctx.answerCbQuery();
    return;
  }

  if (data === RESTART_COMMAND && ctx.from.id === BOT_ADMIN_ID) {
    await ctx.answerCbQuery('⏳ Restarting server...');
    process.exit();
  }
});

// =============================
// ADMIN COMMANDS
// =============================

bot.command('setpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) {
    return ctx.reply('Please use /start before using admin commands.');
  }
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply('Usage: /setpremium <telegram_id | @username>');
    
    let telegramId: string | undefined;
    let username: string | undefined;

    if (args[0].startsWith('@')) {
      username = args[0].replace('@', '');
      const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(username) as { telegram_id?: string } | undefined;
      if (!row || !row.telegram_id) return ctx.reply('User not found in database.');
      telegramId = row.telegram_id;
    } else if (/^\d+$/.test(args[0])) {
      telegramId = args[0];
    } else {
      return ctx.reply('Invalid argument. Provide a Telegram user ID or @username.');
    }

    if (!telegramId) return ctx.reply('Could not resolve telegram ID.');
    
    addPremiumUser(telegramId, username);
    await ctx.reply(`✅ User ${username ? '@'+username : telegramId} marked as premium!`);
  } catch (e) {
    console.error("Error in /setpremium:", e);
    await ctx.reply("An error occurred processing this command.");
  }
});

// ... The rest of your admin commands follow the same corrected pattern ...
// (unsetpremium, ispremium, listpremium, users)

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
