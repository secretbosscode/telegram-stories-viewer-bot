import { jest } from '@jest/globals';
// Mock env-config to avoid requiring actual environment variables
jest.mock('../src/config/env-config', () => ({ BTC_WALLET_ADDRESS: 'addr' }));

import { handleUpgrade } from '../src/controllers/upgrade';
import { IContextBot } from '../src/config/context-interface';
import * as btc from '../src/services/btc-payment';
import { PaymentRow } from '../src/db';

const fakeInvoice = {
  id: 1,
  user_id: '123',
  invoice_amount: 0.0001,
  user_address: 'addr',
  paid_amount: 0,
  expires_at: 0,
} as PaymentRow;

describe('upgrade command', () => {
  test('creates invoice and stores session', async () => {
    const spy = jest.spyOn(btc, 'createInvoice').mockResolvedValue(fakeInvoice);
    const replies: any[] = [];
    const ctx = {
      from: { id: 123 },
      session: {} as any,
      reply: jest.fn((...args) => { replies.push(args); }),
    } as unknown as IContextBot;

    await handleUpgrade(ctx);

    expect(spy).toHaveBeenCalledWith('123', 5);
    expect(ctx.session.upgrade?.invoice).toBe(fakeInvoice);
    expect(replies.length).toBe(1);
    expect(replies[0][0]).toContain('addr');
    spy.mockRestore();
  });
});
