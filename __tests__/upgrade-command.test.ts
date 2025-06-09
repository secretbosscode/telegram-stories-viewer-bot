import { jest } from '@jest/globals';
// Mock env-config to avoid requiring actual environment variables
jest.mock('../src/config/env-config', () => ({ BTC_WALLET_ADDRESS: 'addr', BTC_XPUB: '', BTC_YPUB: '', BTC_ZPUB: '' }));

const sendTemporaryMessage = jest.fn();
jest.mock('../src/lib/helpers.ts', () => ({
  ...(jest.requireActual('../src/lib/helpers.ts') as any),
  sendTemporaryMessage,
}));

const bot = { telegram: { sendMessage: jest.fn(), deleteMessage: jest.fn() } } as any;
jest.mock('../src/index.ts', () => ({ bot }));

import { handleUpgrade } from '../src/controllers/upgrade';
import { IContextBot } from '../src/config/context-interface';
import * as btc from '../src/services/btc-payment';
import { PaymentRow } from '../src/db';

const fakeInvoice = {
  id: 1,
  user_id: '123',
  invoice_amount: 0.0001,
  user_address: 'addr',
  address_index: null,
  paid_amount: 0,
  expires_at: 0,
} as PaymentRow;

describe('upgrade command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  test('creates invoice and stores session', async () => {
    const spy = jest.spyOn(btc, 'createInvoice').mockResolvedValue(fakeInvoice);
    const ctx = {
      from: { id: 123 },
      chat: { id: 1 },
      session: {} as any,
    } as unknown as IContextBot;

    await handleUpgrade(ctx);

    expect(spy).toHaveBeenCalledWith('123', 5);
    expect(ctx.session.upgrade?.invoice).toBe(fakeInvoice);
    expect(sendTemporaryMessage).toHaveBeenCalledWith(
      bot,
      1,
      expect.stringContaining('Send the following amount:'),
      { parse_mode: 'Markdown' },
      60 * 60 * 1000,
    );
    spy.mockRestore();
  });

  test('reuses existing invoice when called again', async () => {
    const spy = jest.spyOn(btc, 'createInvoice').mockResolvedValue(fakeInvoice);
    const ctx = {
      from: { id: 123 },
      chat: { id: 1 },
      session: {} as any,
    } as unknown as IContextBot;

    await handleUpgrade(ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sendTemporaryMessage).toHaveBeenCalledTimes(1);

    await handleUpgrade(ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sendTemporaryMessage).toHaveBeenCalledTimes(2);
    expect(sendTemporaryMessage.mock.calls[1][2]).toContain('already generated');
    expect(sendTemporaryMessage.mock.calls[1][2]).toContain('/verify <txid>');
    spy.mockRestore();
  });
});
