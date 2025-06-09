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
      address_index INTEGER,
      from_address TEXT,
      paid_amount REAL DEFAULT 0,
      expires_at INTEGER,
      paid_at INTEGER
    );
    CREATE TABLE payment_txids (
      invoice_id INTEGER,
      txid TEXT UNIQUE
    );
  `);
  const used = new Set<string>();
  let idx = 0;
  return {
    db,
    insertInvoice: (
      user_id: string,
      invoice_amount: number,
      user_address: string,
      address_index: number | null,
      expires_at: number,
      from_address?: string | null,
    ) => {
      const result = db
        .prepare(`INSERT INTO payments (user_id, invoice_amount, user_address, address_index, from_address, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(user_id, invoice_amount, user_address, address_index, from_address ?? null, expires_at);
      const id = Number(result.lastInsertRowid);
      return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    },
    markInvoicePaid: jest.fn(),
    updatePaidAmount: jest.fn(),
    updateFromAddress: jest.fn(),
    recordTxid: jest.fn((invoice_id: number, txid: string) => { used.add(txid); }),
    isTxidUsed: jest.fn((txid: string) => used.has(txid)),
    getInvoice: (id: number) => db.prepare('SELECT * FROM payments WHERE id = ?').get(id),
    getPendingInvoiceByAddress: (addr: string) =>
      db.prepare('SELECT * FROM payments WHERE user_address = ? AND paid_at IS NULL ORDER BY id DESC LIMIT 1').get(addr),
    reserveAddressIndex: () => idx++,
  };
});

// Mock env-config to supply wallet address
jest.mock('../src/config/env-config', () => ({ BTC_WALLET_ADDRESS: 'addr', BTC_XPUB: '', BTC_ZPUB: '' }));

// Import after mocks
import { db, markInvoicePaid, updatePaidAmount, updateFromAddress, recordTxid, isTxidUsed, insertInvoice } from '../src/db';
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
    (updateFromAddress as jest.Mock).mockClear();
    (recordTxid as jest.Mock).mockClear();
  });

  test('invoice marked paid when 90% received', async () => {
    const invoice = insertInvoice('u1', 1, 'dest', 0, 0, 'sender');

    const tx = {
      txid: 't1',
      vout: [{ scriptpubkey_address: 'dest', value: 0.91 * 1e8 }],
      vin: [{ prevout: { scriptpubkey_address: 'sender' } }],
    };

    const originalFetch = global.fetch;
    global.fetch = (jest.fn() as any).mockResolvedValue({ json: async () => [tx] });

    await btc.checkPayment(invoice as any, 0);

    expect(updatePaidAmount).toHaveBeenCalledWith(invoice.id, 0.91);
    expect(markInvoicePaid).toHaveBeenCalledWith(invoice.id);

    global.fetch = originalFetch as any;
  });

  test('older transactions are ignored', async () => {
    const invoice = insertInvoice('u1', 1, 'dest', 0, 0, 'sender');

    const tx = {
      txid: 't2',
      vout: [{ scriptpubkey_address: 'dest', value: 1 * 1e8 }],
      vin: [{ prevout: { scriptpubkey_address: 'sender' } }],
      status: { block_time: 1000 },
    };

    const originalFetch = global.fetch;
    global.fetch = (jest.fn() as any).mockResolvedValue({
      json: async () => ({ txs: [tx], bitcoin: { usd: 10000 } }),
    });

    await btc.checkPayment(invoice as any, 2000);

    expect(updatePaidAmount).not.toHaveBeenCalled();
    expect(markInvoicePaid).not.toHaveBeenCalled();
    global.fetch = originalFetch as any;
  });
});

describe('verifyPaymentByTxid', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM payments').run();
    (markInvoicePaid as jest.Mock).mockClear();
    (updatePaidAmount as jest.Mock).mockClear();
    (updateFromAddress as jest.Mock).mockClear();
    (recordTxid as jest.Mock).mockClear();
  });

  test('invoice marked paid for provided txid', async () => {
    const invoice = insertInvoice('u1', 1, 'dest', 0, 0);
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

    const res = await btc.verifyPaymentByTxid('abc');

    expect(updatePaidAmount).toHaveBeenCalledWith(invoice.id, 1);
    expect(markInvoicePaid).toHaveBeenCalledWith(invoice.id);
    expect(updateFromAddress).toHaveBeenCalledWith(invoice.id, 'sender');
    expect(recordTxid).toHaveBeenCalledWith(invoice.id, 'abc');
    expect(res?.paid_at).toBeDefined();
    global.fetch = originalFetch as any;
  });

  test('returns null when sender does not match', async () => {
    const invoice = insertInvoice('u1', 1, 'dest', 0, 0, 'expected');
    const tx = {
      vout: [{ scriptpubkey_address: 'dest', value: 1 * 1e8 }],
      vin: [{ prevout: { scriptpubkey_address: 'other' } }],
    };
    const originalFetch = global.fetch;
    global.fetch = (jest.fn() as any)
      .mockResolvedValue({ json: async () => tx })
      .mockResolvedValue({ json: async () => tx })
      .mockResolvedValue({ json: async () => tx })
      .mockResolvedValue({ json: async () => ({ data: tx }) });

    const res = await btc.verifyPaymentByTxid('def');

    expect(res).toBeNull();
    expect(markInvoicePaid).not.toHaveBeenCalled();
    global.fetch = originalFetch as any;
  });

  test('reused txid is rejected', async () => {
    const invoice1 = insertInvoice('u1', 1, 'dest', 0, 0);
    const invoice2 = insertInvoice('u2', 1, 'dest', 1, 0);
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

    await btc.verifyPaymentByTxid('xyz');
    const res = await btc.verifyPaymentByTxid('xyz');

    expect(res).toBeNull();
    expect(markInvoicePaid).toHaveBeenCalledTimes(1);
    global.fetch = originalFetch as any;
  });
});
