import { randomBytes } from 'crypto';
import { insertInvoice, markInvoicePaid, updatePaidAmount, getInvoice, PaymentRow } from '../db';

/** Fetch BTC/USD prices from multiple sources and return the average */
export async function getBtcPriceUsd(): Promise<number> {
  const endpoints = {
    coinbase: 'https://api.coinbase.com/v2/prices/spot?currency=USD',
    binance: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    coingecko: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
  } as const;

  const requests = await Promise.allSettled([
    fetch(endpoints.coinbase).then((r) => r.json()),
    fetch(endpoints.binance).then((r) => r.json()),
    fetch(endpoints.coingecko).then((r) => r.json()),
  ]);

  const prices: number[] = [];
  if (requests[0].status === 'fulfilled') {
    const amt = Number(requests[0].value?.data?.amount);
    if (!isNaN(amt)) prices.push(amt);
  }
  if (requests[1].status === 'fulfilled') {
    const amt = Number(requests[1].value?.price);
    if (!isNaN(amt)) prices.push(amt);
  }
  if (requests[2].status === 'fulfilled') {
    const amt = Number(requests[2].value?.bitcoin?.usd);
    if (!isNaN(amt)) prices.push(amt);
  }

  if (!prices.length) throw new Error('Unable to fetch BTC price');
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

function generateAddress(): string {
  return 'bc1' + randomBytes(20).toString('hex');
}

export async function createInvoice(userId: string, expectedUsd: number): Promise<PaymentRow> {
  const price = await getBtcPriceUsd();
  const invoiceAmount = expectedUsd / price;
  const address = generateAddress();
  const expires = Math.floor(Date.now() / 1000) + 15 * 60;
  return insertInvoice(userId, invoiceAmount, address, expires);
}

async function queryAddressBalance(address: string): Promise<number> {
  const urls = [
    `https://blockstream.info/api/address/${address}`,
    `https://mempool.space/api/address/${address}`,
    `https://api.blockcypher.com/v1/btc/main/addrs/${address}/balance`,
    `https://sochain.com/api/v2/get_address_balance/BTC/${address}`,
  ];

  const results = await Promise.allSettled(urls.map((u) => fetch(u).then((r) => r.json())));
  const amounts: number[] = [];

  if (results[0].status === 'fulfilled') {
    const v = results[0].value;
    const total = v.chain_stats?.funded_txo_sum + v.mempool_stats?.funded_txo_sum;
    if (typeof total === 'number') amounts.push(total / 1e8);
  }
  if (results[1].status === 'fulfilled') {
    const v = results[1].value;
    const total = v.chain_stats?.funded_txo_sum + v.mempool_stats?.funded_txo_sum;
    if (typeof total === 'number') amounts.push(total / 1e8);
  }
  if (results[2].status === 'fulfilled') {
    const v = results[2].value;
    const bal = v.total_received ?? v.balance ?? v.final_balance;
    if (typeof bal === 'number') amounts.push(bal / 1e8);
  }
  if (results[3].status === 'fulfilled') {
    const v = results[3].value;
    const bal = v.data?.confirmed_balance ?? v.data?.confirmed ?? v.data?.balance;
    if (typeof bal === 'string') amounts.push(Number(bal));
  }

  return amounts.length ? Math.max(...amounts) : 0;
}

export async function checkPayment(invoice: PaymentRow): Promise<PaymentRow | null> {
  const balance = await queryAddressBalance(invoice.user_address);
  if (balance > invoice.paid_amount) {
    updatePaidAmount(invoice.id, balance - invoice.paid_amount);
  }

  if (balance >= invoice.invoice_amount) {
    markInvoicePaid(invoice.id);
    return getInvoice(invoice.id) || null;
  }

  const remaining = invoice.invoice_amount - balance;
  if (remaining > 0) {
    const usdRate = await getBtcPriceUsd();
    const remainingUsd = remaining * usdRate;
    return createInvoice(invoice.user_id, remainingUsd);
  }

  return null;
}
