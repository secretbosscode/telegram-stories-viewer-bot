export const MAX_TIMEOUT_ERRORS = 10;
export const TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
let errorTimestamps: number[] = [];

export function recordTimeoutError(err: unknown): void {
  const msg = typeof err === 'string' ? err : (err as any)?.message;
  if (typeof msg !== 'string') return;
  const upper = msg.toUpperCase();
  if (!upper.includes('TIMEOUT') && !upper.includes('NOT CONNECTED')) return;
  const now = Date.now();
  errorTimestamps.push(now);
  errorTimestamps = errorTimestamps.filter(t => now - t < TIME_WINDOW_MS);
  if (errorTimestamps.length >= MAX_TIMEOUT_ERRORS) {
    console.error(
      `[TimeoutMonitor] Exiting after ${errorTimestamps.length} connection errors within ${TIME_WINDOW_MS / 1000} seconds.`
    );
    process.exit(1);
  }
}

export function monitorConsoleErrors(): void {
  const originalError = console.error.bind(console);
  console.error = (...args: any[]) => {
    originalError(...args);
    for (const arg of args) {
      if (typeof arg === 'string' && arg.includes('[TimeoutMonitor]')) continue;
      try {
        recordTimeoutError(arg);
      } catch {}
    }
  };
}
