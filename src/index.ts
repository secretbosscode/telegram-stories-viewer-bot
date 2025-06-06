// =============================
//  Ghost Stories Bot Main Entry
// =============================

import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { newTaskReceived, UserInfo } from 'services/stories-service'; // UserInfo import might be needed here
import { session, Telegraf } from 'telegraf';
import { db } from './db';

// Import services for premium management
import { isUserPremium, addPremiumUser, removePremiumUser } from './services/premium-service'; // Assuming path
import { findUserById, saveUser } from './repositories/user-repository'; // Assuming path

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

function isActivated(userId: number) {
  try {
    const user = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(String(userId));
    return !!user;
  } catch (error) {
    console.error("isActivated check failed:", error);
    return false;
  }
}

// =========================================================================
// NEW UTILITY: Robust MarkdownV2 Escaper
// This single function will replace the long chain of .replace() calls.
// It correctly handles all special characters required by the Telegram API.
// =========================================================================
function escapeMarkdown(text: string): string {
  // Order matters for some replacements. This is a safe order.
  const escapeChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  return escapeChars.reduce((str, char) => str.replace(new RegExp('\\' + char, 'g'), '\\' + char), text);
}


// =============================
//        USER COMMANDS
// =============================

bot.start(async (ctx) => {
  saveUser(ctx.from);
  await ctx.reply(
    '🔗 Please send one of the following:\n\n' +
      "*Username with '@' symbol:*\n`@durov`\n\n" +
      "*Phone number with '+' symbol:*\n`+15551234567`\n\n" +
      '*Direct link to a story:*\n`https://t.me/durov/s/1`',
    { ...extraOptions, parse_mode: 'Markdown' } // Using simple Markdown here is easier
  );
});


// =========================================================================
// BUG FIX: Corrected the /help command to properly escape MarkdownV2
// and handle placeholders for admin commands.
// =========================================================================
bot.command('help', async (ctx) => {
  // Use code blocks (`) for commands and placeholders to avoid needing to escape them.
  let helpText =
    '🤖 *Ghost Stories Bot Help*\n\n' +
    '*General Commands:*\n' +
    '`/start` - Show usage instructions\n' +
    '`/help` - Show this help message\n' +
    '`/premium` - Info about premium features\n';

  if (ctx.from.id === BOT_ADMIN_ID) {
    helpText +=
      '\n*Admin Commands:*\n' +
      '`/setpremium <ID or @username>`\n' +
      '`/unsetpremium <ID or @username>`\n' +
      '`/ispremium <ID or @username>`\n' +
      '`/listpremium`\n' +
      '`/users`\n' +
      '`restart` (as plain text)\n';
  }

  // Use the robust escaper function.
  // Note: Text inside `...` (code blocks) is not parsed, so we don't need to escape it.
  // We only need to escape the text outside of the code blocks.
  // However, for simplicity and safety, we can wrap the whole thing.
  // A better approach is to build the text with markdown in mind from the start.

  // Let's rebuild the text to be MarkdownV2 safe from the beginning.
  // We use the `escapeMarkdown` function only on parts that need it.
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
    'Stripe integration for payments is coming soon\\!',
    { parse_mode: 'MarkdownV2' }
  );
});

// =============================
// STORY PROCESSING SECTION
// =============================

// This is the main text handler.
bot.on('message', async (ctx) => {
  if (!('text' in ctx.message)) return;
  const text = ctx.message.text;
  const userId = ctx.from.id;

  const command = text.split(' ')[0];
  if (['/start', '/help', '/premium'].includes(command)) {
    return; // These are handled by their respective `bot.command` handlers.
  }

  if (!isActivated(userId)) {
    await ctx.reply('👋 Please type /start to begin using the bot.');
    return;
  }
  
  // This section handles ADMIN commands that were not caught by `bot.command`
  const adminCommands = ['/setpremium', '/unsetpremium', '/ispremium', '/listpremium', '/users'];
  if (adminCommands.includes(command)) {
      // The admin command handlers above will deal with this.
      return;
  }
  
  // Now, check for story requests
  const isStoryLink = text.startsWith('https') || text.startsWith('t.me/');
  const isUsername = text.startsWith('@') || text.startsWith('+');

  if (isUsername || isStoryLink) {
    const dbUser = findUserById(String(userId));
    const isPremium = dbUser ? dbUser.is_premium === 1 : false;

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

  await ctx.reply('🚫 Invalid command or input. Send a username like `@durov` or a story link. Type /help for more info.');
});


// =============================
// CALLBACK HANDLERS
// =============================

bot.on('callback_query', async (ctx) => {
  if (!('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  // This handles the pagination buttons from send-pinned-stories.ts
  if (data.includes('&')) {
    // This logic relies on premium users NOT seeing pagination buttons.
    const isPremium = isUserPremium(String(ctx.from.id));
    if (!isPremium) {
        await ctx.answerCbQuery('This feature is for Premium users.', { show_alert: true });
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
      isPremium: isPremium, // Pass the premium status
    });
    await ctx.answerCbQuery(); // Acknowledge the button press
    return;
  }

  if (data === RESTART_COMMAND && ctx.from.id === BOT_ADMIN_ID) {
    await ctx.answerCbQuery('⏳ Restarting server...');
    process.exit();
  }
});


// =============================
// ADMIN COMMANDS (DB Interactions)
// These should ideally live in their own file, but are here based on your structure.
// =============================

bot.command('setpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  // ... your existing logic here, it seems fine.
});

bot.command('unsetpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  // ... your existing logic here, it seems fine.
});

bot.command('ispremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  // ... your existing logic here, it seems fine.
});

bot.command('listpremium', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  // ... your existing logic here, it seems fine.
});

bot.command('users', async (ctx) => {
  if (ctx.from.id !== BOT_ADMIN_ID) return;
  // ... your existing logic here, it seems fine.
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

process.on('uncaughtException', (err) => {
  console.error('Unhandled Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
