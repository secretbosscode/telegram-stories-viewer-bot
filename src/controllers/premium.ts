import { IContextBot } from 'config/context-interface';
import { MAX_MONITORS_PER_USER } from 'services/monitor-service';
import { isUserPremium } from 'services/premium-service';
import { sendTemporaryMessage } from 'lib';
import { bot } from 'index';
import { t } from 'lib/i18n';

/**
 * Handle the `/premium` command.
 * Shows upgrade info or notifies existing premium users.
 */
export async function handlePremium(ctx: IContextBot): Promise<void> {
  const userId = String(ctx.from!.id);
  const locale = ctx.from?.language_code || 'en';
  if (isUserPremium(userId)) {
    await sendTemporaryMessage(bot, ctx.chat!.id, t(locale, 'premium.already'));
    return;
  }
  await ctx.reply(t(locale, 'premium.info', { limit: MAX_MONITORS_PER_USER }), {
    parse_mode: 'Markdown',
  });
}
