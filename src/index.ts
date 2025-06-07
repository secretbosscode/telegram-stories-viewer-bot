// src/index.ts

// =========================================================================
// FINAL FIX 1: Move global error handlers to the absolute top of the file
// This ensures they are attached immediately and can catch any startup errors.
// =========================================================================
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL_ERROR: Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error, origin) => {
  console.error('CRITICAL_ERROR: Uncaught Exception:', error, 'origin:', origin);
});
console.log("Global error handlers have been attached.");


// =============================
//  Ghost Stories Bot Main Entry
// =============================

import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { session, Telegraf } from 'telegraf';

// =========================================================================
// FINAL FIX 2: Import the necessary functions for the startup routine.
// =========================================================================
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

// All other commands (/help, /premium, admin commands, etc.) are correct.
// I have omitted them here for brevity but you should keep them in your file.
// ... your other bot.command(...) handlers go here ...


bot.on('callback_query', async (ctx) => {
  // This logic is correct and calls handleNewTask
  // ...
});

bot.on('text', async (ctx) => {
  // This logic is correct and calls handleNewTask
  // ...
});


// =========================================================================
// FINAL FIX 3: Create a structured startup function.
// =========================================================================

async function startApp() {
  console.log('[App] Initializing...');
  
  // 1. Reset any jobs that were stuck in 'processing' from a previous run.
  // This makes the bot resilient to crashes and restarts.
  resetStuckJobs();

  // 2. Initialize the userbot (gram.js client).
  await initUserbot();

  // 3. Start the main queue processor loop to handle any pending jobs.
  console.log('[App] Starting queue processor...');
  processQueue();

  // 4. Launch the Telegram bot to start receiving new messages.
  bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log('✅ Telegram bot started successfully.');
  });
}

// Run the main startup sequence.
startApp();

// Graceful shutdown handlers
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
