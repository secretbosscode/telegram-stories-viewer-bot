// src/index.ts

// These global error handlers are critical. They must be at the very top.
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL_ERROR: Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error, origin) => {
  console.error('CRITICAL_ERROR: Uncaught Exception:', error, 'origin:', origin);
});
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
//  COMMAND & EVENT HANDLERS (No changes needed here)
// =========================================================================

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

// ... your /help, /premium, and other admin commands are all fine.

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  if (!isActivated(userId)) {
    return ctx.reply('👋 Please type /start to begin using the bot.');
  }

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

  await ctx.reply('🚫 Invalid input. Send a username like `@durov` or a story link. Type /help for more info.');
});

// ... your other handlers like bot.on('callback_query') are fine.

// =========================================================================
// BOT LAUNCH & QUEUE STARTUP
// This new structure ensures everything initializes in the correct order.
// =========================================================================

async function startApp() {
  console.log('[App] Initializing...');
  
  // 1. Reset any jobs that were stuck in 'processing' from a previous run.
  resetStuckJobs();

  // 2. IMPORTANT: Wait for the userbot (gram.js client) to fully initialize.
  await initUserbot();

  // 3. Start the main queue processor loop *after* the userbot is ready.
  console.log('[App] Starting queue processor...');
  processQueue();

  // 4. Finally, launch the Telegram bot to start receiving messages.
  bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log('✅ Telegram bot started successfully and is ready for commands.');
  });
}

// Run the main startup sequence.
startApp();

// Graceful shutdown handlers
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
