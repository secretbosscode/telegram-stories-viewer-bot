export async function getBtcPriceUsd(): Promise<number> {
  try {
    const res = await fetch('https://api.coindesk.com/v1/bpi/currentprice/USD.json');
    const data = await res.json();
    return data.bpi.USD.rate_float;
  } catch (e) {
    console.error('[getBtcPriceUsd] failed', e);
    throw e;
  }
}

export async function createInvoice(userId: number, usdAmount: number): Promise<{ address: string; amountBtc: number }> {
  const price = await getBtcPriceUsd();
  const amountBtc = parseFloat((usdAmount / price).toFixed(8));
  const random = Math.random().toString(36).slice(2, 15);
  const address = `btc_${userId}_${random}`;
  return { address, amountBtc };
}

export async function checkPayment(address: string): Promise<number> {
  try {
    const res = await fetch(`https://blockchain.info/rawaddr/${address}?cors=true`);
    if (!res.ok) return 0;
    const data = await res.json();
    return (data.total_received || 0) / 1e8;
  } catch (e) {
    console.error('[checkPayment] failed', e);
    return 0;
  }
}
