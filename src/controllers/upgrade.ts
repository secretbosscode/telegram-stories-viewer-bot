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
    await ctx.reply(
      `Send *${invoice.invoice_amount.toFixed(8)} BTC* (~$5) to the following address:\n` +
        `\`${invoice.user_address}\`\n` +
        'Reply with the address you will pay from within one hour.',
      { parse_mode: 'Markdown' },
    );
  } catch (e) {
    console.error('upgrade cmd error', e);
    await ctx.reply('Failed to create invoice. Please try again later.');
  }
}
