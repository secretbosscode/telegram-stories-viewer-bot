// In: src/index.ts

import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { newTaskReceived, UserInfo } from 'services/stories-service';
import { session, Telegraf } from 'telegraf';
import { db } from './db';

import { isUserPremium, addPremiumUser, removePremiumUser } from './services/premium-service';
// CORRECTED: Import all necessary functions from the repository.
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

  const publicCommands = ['/start', '/help', '/premium'];
  if (publicCommands.includes(text.split(' ')[0])) {
    return;
  }
  
  // CORRECTED: Use userHasStarted from the repository instead of the local isActivated function.
  if (!userHasStarted(String(userId))) {
    await ctx.reply('👋 Please type /start to begin using the bot.');
    return;
  }
  
  const adminCommands = ['/setpremium', '/unsetpremium', '/ispremium', '/listpremium', '/users'];
  if (adminCommands.includes(text.split(' ')[0])) {
      return;
  }
  
  const isStoryLink = text.startsWith('https') || text.startsWith('t.me/');
  const isUsername = text.startsWith('@') || text.startsWith('+');

  if (isUsername || isStoryLink) {
    // CRITICAL FIX: Check the user's premium status from the database
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
  // ... This section can be improved later to also check premium status ...
});

// =============================
// ADMIN COMMANDS
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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
process.on('uncaughtException', (err) => { console.error('Unhandled Exception:', err); });
process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection at:', promise, 'reason:', reason); });
