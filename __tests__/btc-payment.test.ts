import { jest } from '@jest/globals';

// Mock ../src/db with an in-memory sqlite DB
jest.mock('../src/db', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      invoice_amount REAL,
      user_address TEXT,
      from_address TEXT,
      paid_amount REAL DEFAULT 0,
      expires_at INTEGER,
      paid_at INTEGER
    );
  `);
  return {
    db,
    insertInvoice: (user_id: string, invoice_amount: number, user_address: string, expires_at: number, from_address?: string | null) => {
      const result = db
        .prepare(`INSERT INTO payments (user_id, invoice_amount, user_address, from_address, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run(user_id, invoice_amount, user_address, from_address ?? null, expires_at);
      const id = Number(result.lastInsertRowid);
      return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    },
    markInvoicePaid: jest.fn(),
    updatePaidAmount: jest.fn(),
    getInvoice: (id: number) => db.prepare('SELECT * FROM payments WHERE id = ?').get(id),
  };
});

// Mock env-config to supply wallet address
jest.mock('../src/config/env-config', () => ({ BTC_WALLET_ADDRESS: 'addr' }));

// Import after mocks
import { db, markInvoicePaid, updatePaidAmount, insertInvoice } from '../src/db';
import * as btc from '../src/services/btc-payment';

describe('createInvoice rounding', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM payments').run();
  });

  test('invoice amount rounded to 8 decimals', async () => {
    const price = 12345.6789;
    const originalFetch = global.fetch;
    global.fetch = (jest.fn() as any)
      .mockResolvedValueOnce({ json: async () => ({ bitcoin: { usd: price } }) })
      .mockResolvedValueOnce({ json: async () => ({ data: { amount: price } }) })
      .mockResolvedValueOnce({ json: async () => ({ price }) })
      .mockResolvedValueOnce({ json: async () => ({ last: price }) })
      .mockResolvedValueOnce({ json: async () => ({ result: { XXBTZUSD: { c: [price] } } }) })
      .mockResolvedValueOnce({ json: async () => ({ data: [{ last: price }] }) })
      .mockResolvedValueOnce({ json: async () => ({ USD: price }) })
      .mockResolvedValueOnce({ json: async () => ({ quotes: { USD: { price } } }) })
      .mockResolvedValueOnce({ json: async () => ({ data: { priceUsd: price } }) });

    const invoice = await btc.createInvoice('u1', 5);
    const expected = Math.round((5 / price) * 1e8) / 1e8;
    expect(invoice.invoice_amount).toBeCloseTo(expected, 8);
    const row = db.prepare('SELECT invoice_amount FROM payments WHERE id = ?').get(invoice.id) as any;
    expect(row.invoice_amount).toBeCloseTo(expected, 8);
    global.fetch = originalFetch as any;
  });
});

describe('checkPayment tolerance', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM payments').run();
    (markInvoicePaid as jest.Mock).mockClear();
    (updatePaidAmount as jest.Mock).mockClear();
  });

  test('invoice marked paid when 90% received', async () => {
    const invoice = insertInvoice('u1', 1, 'dest', 0, 'sender');

    const tx = {
      vout: [{ scriptpubkey_address: 'dest', value: 0.91 * 1e8 }],
      vin: [{ prevout: { scriptpubkey_address: 'sender' } }],
    };

    const originalFetch = global.fetch;
    global.fetch = (jest.fn() as any).mockResolvedValue({ json: async () => [tx] });

    await btc.checkPayment(invoice as any);

    expect(updatePaidAmount).toHaveBeenCalledWith(invoice.id, 0.91);
    expect(markInvoicePaid).toHaveBeenCalledWith(invoice.id);

    global.fetch = originalFetch as any;
  });
});

describe('verifyPaymentByTxid', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM payments').run();
    (markInvoicePaid as jest.Mock).mockClear();
    (updatePaidAmount as jest.Mock).mockClear();
  });

  test('invoice marked paid for provided txid', async () => {
    const invoice = insertInvoice('u1', 1, 'dest', 0);
    const tx = {
      vout: [{ scriptpubkey_address: 'dest', value: 1 * 1e8 }],
      vin: [{ prevout: { scriptpubkey_address: 'sender' } }],
    };
    const originalFetch = global.fetch;
    global.fetch = (jest.fn() as any)
      .mockResolvedValue({ json: async () => tx })
      .mockResolvedValue({ json: async () => tx })
      .mockResolvedValue({ json: async () => tx })
      .mockResolvedValue({ json: async () => ({ data: tx }) });

    const res = await btc.verifyPaymentByTxid(invoice.id, 'abc');

    expect(updatePaidAmount).toHaveBeenCalledWith(invoice.id, 1);
    expect(markInvoicePaid).toHaveBeenCalledWith(invoice.id);
    expect(res?.paid_at).toBeDefined();
    global.fetch = originalFetch as any;
  });
});
