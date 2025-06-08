import { IContextBot } from 'config/context-interface';
import { createInvoice } from 'services/btc-payment';

/**
 * Handle the `/upgrade` command. Creates a BTC invoice and stores
 * the invoice information in the session so the payment can be
 * tracked later.
 */
export async function handleUpgrade(ctx: IContextBot): Promise<void> {
  try {
    const invoice = await createInvoice(String(ctx.from!.id), 5);
    ctx.session ??= {} as any;
    ctx.session.upgrade = {
      invoice,
      awaitingAddressUntil: Date.now() + 60 * 60 * 1000,
    };
    const msg = [
      'Send the following amount:',
      '```',
      `${invoice.invoice_amount.toFixed(8)} BTC`,
      '```',
      '\(~$5\) to the following address:',
      '```',
      invoice.user_address,
      '```',
      'Reply with the address you will pay from within one hour\.',
    ].join('\n');
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    console.error('upgrade cmd error', e);
    await ctx.reply('Failed to create invoice. Please try again later.');
  }
}
