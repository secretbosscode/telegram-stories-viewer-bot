// In: src/index.ts

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

bot.use(session());

bot.catch((error) => {
  console.error('A global error occurred:', error);
});

const extraOptions: any = {
  link_preview_options: { is_disabled: true },
};

function isActivated(userId: number): boolean {
  try {
    const user = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(String(userId));
    return !!user;
  } catch (error) {
    console.error(`[isActivated] Database check failed for user ${userId}:`, error);
    return false;
  }
}

// ... your /start, /help, and /premium commands are unchanged and correct ...
bot.start(async (ctx) => { /* ... */ });
bot.command('help', async (ctx) => { /* ... */ });
bot.command('premium', async (ctx) => { /* ... */ });


// =============================
// MAIN MESSAGE HANDLER
// =============================
bot.on('message', async (ctx) => {
  if (!('text' in ctx.message)) return;
  const text = ctx.message.text;
  const userId = ctx.from.id;

  const command = text.split(' ')[0];

  const knownCommands = ['/start', '/help', '/premium', '/setpremium', '/unsetpremium', '/ispremium', '/listpremium', '/users'];
  if (knownCommands.includes(command)) {
    return;
  }
  
  if (!isActivated(userId)) {
    await ctx.reply('👋 Please type /start to begin using the bot.');
    return;
  }

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
  // ... this section is unchanged and looks fine ...
});


// =============================
// ADMIN COMMANDS
// =============================

bot.command('setpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  // BUG FIX: Add activation check and try/catch for robustness.
  if (!isActivated(ctx.from.id)) {
    return ctx.reply('Please use /start before using admin commands.');
  }

  try {
    const args = ctx.message.text.split(' ').slice(1);
    // ... rest of your logic ...
    addPremiumUser(telegramId, username); // This seems to be missing await if it's async
    await ctx.reply(`✅ User ${username ? '@'+username : telegramId} marked as premium!`);
  } catch (e) {
    console.error("Error in /setpremium:", e);
    await ctx.reply("An error occurred processing this command.");
  }
});

bot.command('unsetpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) {
    return ctx.reply('Please use /start before using admin commands.');
  }
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    // ... rest of your logic ...
    removePremiumUser(telegramId);
    await ctx.reply(`✅ User ${username ? '@'+username : telegramId} is no longer premium.`);
  } catch (e) {
    console.error("Error in /unsetpremium:", e);
    await ctx.reply("An error occurred processing this command.");
  }
});

bot.command('ispremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) {
    return ctx.reply('Please use /start before using admin commands.');
  }
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    // ... rest of your logic ...
    const premium = isUserPremium(telegramId);
    await ctx.reply(premium ? `✅ User is PREMIUM.` : `❌ User is NOT premium.`);
  } catch (e) {
    console.error("Error in /ispremium:", e);
    await ctx.reply("An error occurred processing this command.");
  }
});

bot.command('listpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  // BUG FIX: Add activation check and try/catch for robustness.
  if (!isActivated(ctx.from.id)) {
    return ctx.reply('Please use /start before using admin commands.');
  }
  
  try {
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
  } catch (e) {
    console.error("Error in /listpremium:", e);
    await ctx.reply("An error occurred while fetching premium users.");
  }
});

bot.command('users', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  // BUG FIX: Add activation check and try/catch for robustness.
  if (!isActivated(ctx.from.id)) {
    return ctx.reply('Please type /start first to use admin commands.');
  }

  try {
    const rows = db.prepare('SELECT telegram_id, username, is_premium FROM users').all() as { telegram_id: string, username?: string, is_premium?: number }[];
    if (!rows.length) {
      await ctx.reply('No users found in the database.');
      return;
    }
    let msg = `👥 Users (${rows.length}):\n`;
    rows.forEach((u, i) => {
      msg += `${i + 1}. ${u.username ? '@'+u.username : u.telegram_id} [${u.is_premium ? 'PREMIUM' : 'FREE'}]\n`;
    });
    await ctx.reply(msg);
  } catch (e) {
    console.error("Error in /users command:", e);
    await ctx.reply("An error occurred while fetching users from the database.");
  }
});

// =============================
// BOT LAUNCH/SHUTDOWN
// =============================

bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('✅ Telegram bot started.');
});
initUserbot();

// Process signal handlers are unchanged...
