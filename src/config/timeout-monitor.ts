// Allow fewer consecutive failures before triggering a restart so the bot
// recovers automatically when the Telegram client gets stuck.
export const MAX_TIMEOUT_ERRORS = 5;
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

/**
 * Previously this replaced console.error and fed every logged argument into
 * recordTimeoutError, so five *handled* errors whose text merely contained
 * "timeout" or "not connected" would exit the process, often mid-delivery. A
 * single connection blip during a concurrent download batch was enough.
 *
 * Connection health is now reported explicitly by the userbot transport layer
 * (see config/userbot.ts), which is the only place that can tell a fatal client
 * failure from a recovered one. This is kept as a no-op so existing callers and
 * tests continue to work.
 *
 * @deprecated Call recordTimeoutError directly from connection handling instead.
 */
export function monitorConsoleErrors(): void {
  // Intentionally does nothing. See the note above.
}
