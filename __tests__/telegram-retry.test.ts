import { withTelegramRetry } from '../src/lib/telegram-retry';

test('retries on no workers error and eventually succeeds', async () => {
  let attempts = 0;
  const fn = jest.fn().mockImplementation(() => {
    attempts++;
    if (attempts < 3) {
      const err: any = new Error('No workers running');
      err.code = -500;
      err.errorMessage = 'No workers running';
      return Promise.reject(err);
    }
    return Promise.resolve('ok');
  });
  const result = await withTelegramRetry(fn, 5, 1);
  expect(result).toBe('ok');
  expect(attempts).toBe(3);
});

test('throws after exhausting retries', async () => {
  let attempts = 0;
  const fn = jest.fn().mockImplementation(() => {
    attempts++;
    const err: any = new Error('No workers running');
    err.code = -500;
    err.errorMessage = 'No workers running';
    return Promise.reject(err);
  });
  await expect(withTelegramRetry(fn, 2, 1)).rejects.toThrow('No workers running');
  expect(attempts).toBe(2);
});
