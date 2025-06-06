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
const RESTART_COMMAND = 'restart'; // This is used for the callback_data on the button

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


// =============================
//  COMMAND HANDLERS
// =============================
// By defining all specific commands first, Telegraf will match them before
// falling back to the general `bot.on('text')` handler.

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
      // CORRECTED: Updated help text to reflect the /restart command
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

// COMMENT: Changed from plain text to a proper /restart command for consistency.
bot.command('restart', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  await ctx.reply('Are you sure you want to restart?', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Yes, Restart', callback_data: RESTART_COMMAND }]],
    },
  });
});

bot.command('setpremium', async (ctx) => { /* ...your existing correct logic... */ });
bot.command('unsetpremium', async (ctx) => { /* ...your existing correct logic... */ });
bot.command('ispremium', async (ctx) => { /* ...your existing correct logic... */ });
bot.command('listpremium', async (ctx) => { /* ...your existing correct logic... */ });
bot.command('users', async (ctx) => { /* ...your existing correct logic... */ });


// =============================
//  EVENT & FALLBACK HANDLERS
// =============================

bot.on('callback_query', async (ctx) => {
  if (!('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  if (data === RESTART_COMMAND && ctx.from.id === BOT_ADMIN_ID) {
    await ctx.answerCbQuery('⏳ Restarting server...');
    process.exit();
  }

  if (data.includes('&')) {
    // ... pagination logic unchanged ...
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  if (!isActivated(userId)) {
    return ctx.reply('👋 Please type /start to begin using the bot.');
  }

  // COMMENT: The plain-text 'restart' check is no longer needed here.
  // It is now handled by bot.command('restart', ...) above.

  // Handle story requests
  const isStoryLink = text.startsWith('https') || text.startsWith('t.me/');
  const isUsername = text.startsWith('@') || text.startsWith('+');

  if (isUsername || isStoryLink) {
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

  // If the text was not a command and not a story request, send this fallback.
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
