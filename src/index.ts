// src/index.ts

// Global error handlers must be at the absolute top.
process.on('unhandledRejection', (reason, promise) => { console.error('CRITICAL_ERROR: Unhandled Rejection at:', promise, 'reason:', reason); });
process.on('uncaughtException', (error, origin) => { console.error('CRITICAL_ERROR: Uncaught Exception:', error, 'origin:', origin); });
console.log("Global error handlers have been attached.");

import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { session, Telegraf } from 'telegraf';
import { db, resetStuckJobs } from './db';
import { processQueue, handleNewTask } from './services/queue-manager';
import { saveUser } from './repositories/user-repository';
import { isUserPremium, addPremiumUser, removePremiumUser } from './services/premium-service';

export const bot = new Telegraf<IContextBot>(BOT_TOKEN);
const RESTART_COMMAND = 'restart';
const extraOptions: any = { link_preview_options: { is_disabled: true } };

bot.use(session());
bot.catch((error, ctx) => {
  console.error(`A global error occurred for chat ${ctx.chat?.id}:`, error);
  ctx.reply('Sorry, an unexpected error occurred. Please try again later.').catch(() => {});
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
//  FINAL FIX: Handlers are now ordered from most specific to least specific.
// =========================================================================

// 1. Specific command handlers come first.
bot.start(async (ctx) => {
  await saveUser(ctx.from);
  await ctx.reply(
    "🔗 Please send one of the following:\n\n" +
      "*Username with '@' symbol:*\n`@durov`\n\n" +
      "*Phone number with '+' symbol:*\n`+15551234567`\n\n" +
      '*Direct link to a story:*\n`https://t.me/durov/s/1`',
    { ...extraOptions, parse_mode: 'Markdown' }
  );
});

bot.command('help', async (ctx) => {
  let finalHelpText = '*Ghost Stories Bot Help*\\n\\n' +
    '*General Commands:*\\n' +
    '`/start` \\- Show usage instructions\\n' +
    '`/help` \\- Show this help message\\n' +
    '`/premium` \\- Info about premium features\\n';

  if (ctx.from.id.toString() === BOT_ADMIN_ID) {
    finalHelpText += '\\n*Admin Commands:*\\n' +
      '`/setpremium <ID or @username>` \\- Mark user as premium\\n' +
      '`/unsetpremium <ID or @username>` \\- Remove premium status\\n' +
      '`/ispremium <ID or @username>` \\- Check if user is premium\\n' +
      '`/listpremium` \\- List all premium users\\n' +
      '`/users` \\- List all users\\n' +
      '`/restart` \\- Shows the restart confirmation button\\n';
  }
  // Note: Switched to MarkdownV2 and escaped special characters.
  await ctx.reply(finalHelpText, { parse_mode: 'MarkdownV2' });
});

bot.command('premium', async (ctx) => {
    await ctx.reply(
        '🌟 *Premium Access*\\n\\n' +
        'Premium users get:\\n' +
        '✅ Unlimited story downloads\\n' +
        '✅ No cooldowns or waiting in queues\\n\\n' +
        'Payments and subscriptions are coming soon\\!',
        { parse_mode: 'MarkdownV2' }
    );
});

// ... your other admin bot.command() handlers go here ...
bot.command('users', async (ctx) => {
    // ...
});
bot.command('setpremium', async (ctx) => {
    // ...
});
// etc.

// 2. More specific event handlers like 'callback_query' come next.
bot.on('callback_query', async (ctx) => {
    // your callback query logic is fine
});

// 3. The generic, catch-all 'text' handler comes LAST.
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  if (!isActivated(userId)) {
    return ctx.reply('👋 Please type /start to begin using the bot.');
  }
  
  // This text handler should now ONLY process story requests.
  // All commands like /help, /start, etc. have already been handled.
  const isStoryLink = text.startsWith('https') || text.startsWith('t.me/');
  const isUsername = text.startsWith('@') || text.startsWith('+');

  if (isUsername || isStoryLink) {
    const isPremium = isUserPremium(String(userId));
    handleNewTask({
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

  // If the text was not a command and not a valid story request, send the fallback.
  await ctx.reply('🚫 Invalid input. Send a username like `@durov` or a story link. Type /help for more info.');
});

// =============================
// BOT LAUNCH & QUEUE STARTUP
// =============================

async function startApp() {
  console.log('[App] Initializing...');
  resetStuckJobs();
  await initUserbot();
  console.log('[App] Starting queue processor...');
  processQueue();
  bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log('✅ Telegram bot started successfully and is ready for commands.');
  });
}

startApp();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
