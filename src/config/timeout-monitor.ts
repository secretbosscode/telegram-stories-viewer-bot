export const MAX_TIMEOUT_ERRORS = 10;
export const TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
let timeouts: number[] = [];

export function recordTimeoutError(err: unknown): void {
  const msg = typeof err === 'string' ? err : (err as any)?.message;
  if (typeof msg !== 'string') return;
  if (!msg.toUpperCase().includes('TIMEOUT')) return;
  const now = Date.now();
  timeouts.push(now);
  timeouts = timeouts.filter(t => now - t < TIME_WINDOW_MS);
  if (timeouts.length >= MAX_TIMEOUT_ERRORS) {
    console.error(
      `[TimeoutMonitor] Exiting after ${timeouts.length} TIMEOUT errors within ${TIME_WINDOW_MS / 1000} seconds.`
    );
    process.exit(1);
  }
}
