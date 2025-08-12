export function isNoWorkersError(err: unknown): boolean {
  const code = (err as any)?.code;
  const msg = (err as any)?.errorMessage || (err as any)?.message;
  return code === -500 && typeof msg === 'string' && msg.includes('No workers running');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTelegramRetry<T>(
  fn: () => Promise<T>,
  attempts = 5,
  baseDelayMs = 1000,
): Promise<T> {
  let lastErr: unknown;
  let delay = baseDelayMs;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isNoWorkersError(err) || i === attempts - 1) {
        throw err;
      }
      await sleep(delay);
      delay *= 2;
    }
  }
  throw lastErr;
}

export function wrapClientWithRetry<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target as any, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: any[]) => withTelegramRetry(() => (value as any).apply(target, args));
    },
  });
}
