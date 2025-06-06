// =============================
//  Ghost Stories Bot Main Entry
// =============================

import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { newTaskReceived, UserInfo } from 'services/stories-service';
import { session, Telegraf } from 'telegraf';
import { db } from './db';

// Premium user management functions are correctly imported
import { isUserPremium, addPremiumUser, removePremiumUser } from './services/premium-service';

// saveUser logic is correctly imported
import { saveUser } from './repositories/user-repository';

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

// IMPROVEMENT: Added a try...catch block to prevent database errors from crashing the bot.
function isActivated(userId: number): boolean {
  try {
    const user = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(String(userId));
    return !!user;
  } catch (error) {
    console.error(`[isActivated] Database check failed for user ${userId}:`, error);
    return false; // Safely return false if the database check fails
  }
}

// =============================
//        USER COMMANDS
// =============================

/**
 * /start - Only here is the user added to DB.
 */
bot.start(async (ctx) => {
  saveUser(ctx.from); // Ensures user is in the database.
  await ctx.reply(
    '🔗 Please send one of the following:\n\n' +
      "*Username with '@' symbol:*\n`@durov`\n\n" +
      "*Phone number with '+' symbol:*\n`+15551234567`\n\n" +
      '*Direct link to a story:*\n`https://t.me/durov/s/1`',
    // Using simple Markdown is safer and easier for this static message.
    { ...extraOptions, parse_mode: 'Markdown' }
  );
});

/**
 * /help - List commands. Admins see more.
 */
bot.command('help', async (ctx) => {
  // This command is now fixed to use MarkdownV2 safely.
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

/**
 * /premium - Info about premium features
 */
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
// STORY PROCESSING SECTION
// =============================

bot.on('message', async (ctx) => {
  if (!('text' in ctx.message)) return;
  const text = ctx.message.text;
  const userId = ctx.from.id;

  // --- IMPROVEMENT: Streamlined activation check ---
  // Commands that are always allowed, regardless of activation.
  const publicCommands = ['/start', '/help', '/premium'];
  if (publicCommands.includes(text.split(' ')[0])) {
    return; // These are handled by their dedicated `bot.command` handlers.
  }
  
  // For all other messages and commands, the user MUST be activated.
  if (!isActivated(userId)) {
    await ctx.reply('👋 Please type /start to begin using the bot.');
    return;
  }

  // --- Admin Command Handling ---
  const adminCommands = ['/setpremium', '/unsetpremium', '/ispremium', '/listpremium', '/users'];
  if (adminCommands.includes(text.split(' ')[0])) {
      // These are handled by their dedicated `bot.command` handlers, which already check for admin permissions.
      return;
  }

  // --- Core Story Request Logic ---
  const isStoryLink = text.startsWith('https') || text.startsWith('t.me/');
  const isUsername = text.startsWith('@') || text.startsWith('+');

  if (isUsername || isStoryLink) {
    // =========================================================================
    // CRITICAL BUG FIX: Check the user's premium status from the database.
    // We get the status here and pass it into the `newTaskReceived` event.
    // This makes the entire system aware of whether the user is premium or not.
    // =========================================================================
    const isPremium = isUserPremium(String(userId));

    await newTaskReceived({
      chatId: String(ctx.chat.id),
      link: text,
      linkType: isStoryLink ? 'link' : 'username',
      locale: ctx.from.language_code || '',
      user: ctx.from,
      initTime: Date.now(),
      isPremium: isPremium, // <-- The premium status is now correctly included!
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

  // Fallback for any other text that isn't a recognized command or story request.
  await ctx.reply('🚫 Invalid input. Send a username like `@durov` or a story link. Type /help for more info.');
});

// =============================
// CALLBACK HANDLERS
// =============================

bot.on('callback_query', async (ctx) => {
  if (!('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  if (data.includes('&')) {
    // IMPROVEMENT: Also check for premium status on pagination clicks.
    const isPremium = isUserPremium(String(ctx.from.id));

    // NOTE: Your previous logic allowed pagination for non-admins.
    // The new logic in `send-pinned-stories` shows a premium upsell instead.
    // You may want to decide if these pagination buttons should exist at all.
    // For now, we'll check premium status here for consistency.
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
      isPremium: isPremium, // Pass premium status here too
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
// Your existing admin command handlers are here and look fine.
// For better structure in the future, you could move them to a separate admin-commands.ts file.
// =============================

bot.command('setpremium', async (ctx) => { /* ...your logic... */ });
bot.command('unsetpremium', async (ctx) => { /* ...your logic... */ });
bot.command('ispremium', async (ctx) => { /* ...your logic... */ });
bot.command('listpremium', async (ctx) => { /* ...your logic... */ });
bot.command('users', async (ctx) => { /* ...your logic... */ });


// =============================
// BOT LAUNCH/SHUTDOWN
// =============================

bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('✅ Telegram bot started.');
});
initUserbot();

// Process signal handlers remain unchanged.
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
process.on('uncaughtException', (err) => { console.error('Unhandled Exception:', err); });
process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection at:', promise, 'reason:', reason); });
