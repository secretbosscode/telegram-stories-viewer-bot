import { IContextBot } from 'config/context-interface';
import {
  BOT_ADMIN_ID,
  BOT_TOKEN,
  // SUPABASE_API_KEY,   // Removed
  // SUPABASE_PROJECT_URL, // Removed
} from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { newTaskReceived } from 'services/stories-service';
import { session, Telegraf } from 'telegraf';
import { callbackQuery, message } from 'telegraf/filters';

// import { createClient } from '@supabase/supabase-js'; // Removed
import { db } from './db'; // Adjust path as needed
import { isUserPremium, addPremiumUser } from 'services/premium-service';

export const bot = new Telegraf<IContextBot>(BOT_TOKEN);
const RESTART_COMMAND = 'restart';

bot.use(session());

bot.catch((error) => {
  console.error(error, 'INDEX.TS');
});

const extraOptions: any = {
  link_preview_options: {
    is_disabled: true,
  },
};

bot.start(async (ctx) => {
  await ctx.reply(
    '🔗 Please send 1 of the next options:\n\n' +
      "username (with '@' symbol):\n@chupapee\n\n" +
      "or phone number (with '+' symbol):\n+71234567890\n\n" +
      'or the direct link to story:\nhttps://t.me/durov/s/1',
    extraOptions
  );
});

bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  console.log('Received text:', text, 'from:', ctx.from?.id);

  // username or phone number
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

  // particular story link
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

  // restart action
  if (ctx.from.id === BOT_ADMIN_ID && ctx.message.text === RESTART_COMMAND) {
    await ctx.reply('Are you sure?', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Yes', callback_data: RESTART_COMMAND }]],
      },
    });
    return;
  }

  await ctx.reply(
    '🚫 Please send a valid link to user (username or phone number)'
  );
});

bot.on(callbackQuery('data'), async (ctx) => {
  // handle pinned stories pagination
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

  // restart action
  if (
    ctx.callbackQuery.data === RESTART_COMMAND &&
    ctx?.from?.id === BOT_ADMIN_ID
  ) {
    await ctx.answerCbQuery('⏳ Restarting...');
    process.exit();
  }
});

/* --- ADMIN-ONLY /setpremium COMMAND --- */
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
    // Lookup in DB for telegram_id by username
    const row = db.prepare('SELECT telegram_id FROM users WHERE username = ?').get(username);
    if (!row) {
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

  addPremiumUser(telegramId, username);
  await ctx.reply(`✅ User ${username ? '@'+username : telegramId} marked as premium!`);
});
/* --- END ADMIN-ONLY /setpremium COMMAND --- */

bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('Telegram bot started.');
});
initUserbot();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('Unhandled Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
