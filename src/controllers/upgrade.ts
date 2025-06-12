import { IContextBot } from 'config/context-interface';
import { createInvoice } from 'services/btc-payment';
import { getActiveInvoiceForUser } from 'db';
import { bot } from 'index';
import { sendTemporaryMessage } from 'lib';
import { t } from 'lib/i18n';

/**
 * Handle the `/upgrade` command. Creates a BTC invoice and stores
 * the invoice information in the session so the payment can be
 * tracked later.
 */
export async function handleUpgrade(ctx: IContextBot): Promise<void> {
  try {
    const userId = String(ctx.from!.id);
    ctx.session ??= {} as any;

    let state = ctx.session.upgrade;

    if (!state || Date.now() > state.awaitingAddressUntil) {
      const existing = getActiveInvoiceForUser(userId);
      if (existing) {
        state = ctx.session.upgrade = {
          invoice: existing,
          awaitingAddressUntil: existing.expires_at! * 1000,
        };
      }
    }

    if (state && Date.now() < state.awaitingAddressUntil) {
      const remainingMs = state.awaitingAddressUntil - Date.now();
      const mins = Math.ceil(remainingMs / 60000);
      const msg = [
        '⚠️ You already generated an invoice. Pay:',
        '```',
        `${state.invoice.invoice_amount.toFixed(8)} BTC`,
        '```',
        'to address:',
        '```',
        state.invoice.user_address,
        '```',
        `Invoice expires in ${mins} minute${mins === 1 ? '' : 's'}.`,
        'Once paid, run `/verify <txid>` within one hour to confirm.',
        "The txid (transaction hash) is shown in your wallet's transaction details.",
        'Example: `2d339983a78206050b4d70c15c5e14a3553438b25caedebdf2bb2f7162e33d59`',
        '',
        'Paying more than the above amount will credit extra days based on the current BTC value.',
        'For example: paying double grants 60 days, paying triple grants 90 days.',
      ].join('\n');
      await sendTemporaryMessage(
        bot,
        ctx.chat!.id,
        msg,
        { parse_mode: 'Markdown' },
        remainingMs,
      );
      return;
    }

    const invoice = await createInvoice(userId, 5);
    ctx.session.upgrade = {
      invoice,
      awaitingAddressUntil: Date.now() + 60 * 60 * 1000,
    };
    const msg = [
      'Send the following amount:',
      '```',
      `${invoice.invoice_amount.toFixed(8)} BTC`,
      '```',
      '(~$5) to the following address:',
      '```',
      invoice.user_address,
      '```',
      'Once paid, run `/verify <txid>` within one hour to confirm.',
      "The txid (transaction hash) is shown in your wallet's transaction details.",
      'Example: `2d339983a78206050b4d70c15c5e14a3553438b25caedebdf2bb2f7162e33d59`',
      '',
      'Paying more than the above amount will credit extra days based on the current BTC value.',
      'For example: paying double grants 60 days, paying triple grants 90 days.',
    ].join('\n');
    await sendTemporaryMessage(
      bot,
      ctx.chat!.id,
      msg,
      { parse_mode: 'Markdown' },
      60 * 60 * 1000,
    );
  } catch (e) {
    console.error('upgrade cmd error', e);
    const locale = ctx.from?.language_code || 'en';
    await ctx.reply(t(locale, 'error.generic'));
  }
}
