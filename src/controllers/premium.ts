import 'services/stars-delivery-guard';
import { IContextBot } from 'config/context-interface';
import { MAX_MONITORS_PER_USER } from 'services/monitor-service';
import { isUserPremium } from 'services/premium-service';
import { isStarsMode } from 'services/stars-payment';
import { sendTemporaryMessage } from 'lib';
import { bot } from 'index';
import { t } from 'lib/i18n';

/**
 * Handle the `/premium` command.
 * Shows the active payment model or notifies existing premium users.
 */
export async function handlePremium(ctx: IContextBot): Promise<void> {
  const userId = String(ctx.from!.id);
  const locale = ctx.from?.language_code || 'en';
  if (isUserPremium(userId)) {
    await sendTemporaryMessage(bot, ctx.chat!.id, t(locale, 'premium.already'));
    return;
  }
  if (isStarsMode()) {
    await ctx.reply(t(locale, 'stars.premiumInfo'));
    return;
  }
  await ctx.reply(t(locale, 'premium.info', { limit: MAX_MONITORS_PER_USER }), {
    parse_mode: 'Markdown',
  });
}
