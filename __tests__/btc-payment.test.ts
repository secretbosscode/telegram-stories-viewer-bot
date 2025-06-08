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
      paid_amount REAL DEFAULT 0,
      expires_at INTEGER,
      paid_at INTEGER
    );
  `);
  return {
    db,
    insertInvoice: (user_id: string, invoice_amount: number, user_address: string, expires_at: number) => {
      const result = db
        .prepare(`INSERT INTO payments (user_id, invoice_amount, user_address, expires_at) VALUES (?, ?, ?, ?)`)
        .run(user_id, invoice_amount, user_address, expires_at);
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
import { db } from '../src/db';
import * as btc from '../src/services/btc-payment';

describe('createInvoice rounding', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM payments').run();
  });

  test('invoice amount rounded to 8 decimals', async () => {
    const price = 12345.6789;
    const originalFetch = global.fetch;
    global.fetch = (jest.fn() as any)
      .mockResolvedValueOnce({ json: async () => ({ data: { amount: price } }) })
      .mockResolvedValueOnce({ json: async () => ({ price }) })
      .mockResolvedValueOnce({ json: async () => ({ bitcoin: { usd: price } }) });

    const invoice = await btc.createInvoice('u1', 5);
    const expected = Math.round((5 / price) * 1e8) / 1e8;
    expect(invoice.invoice_amount).toBeCloseTo(expected, 8);
    const row = db.prepare('SELECT invoice_amount FROM payments WHERE id = ?').get(invoice.id) as any;
    expect(row.invoice_amount).toBeCloseTo(expected, 8);
    global.fetch = originalFetch as any;
  });
});
