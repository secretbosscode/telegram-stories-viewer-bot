import { jest } from '@jest/globals';

jest.mock('../src/config/env-config', () => ({
  USERBOT_API_HASH: 'h',
  USERBOT_API_ID: 1,
  USERBOT_PHONE_NUMBER: '+1',
  USERBOT_PASSWORD: '',
  USERBOT_PHONE_CODE: '',
}));

const recordTimeoutError = jest.fn();
jest.mock('../src/config/timeout-monitor', () => ({ recordTimeoutError }));

class FakeTelegramClient {
  session: any = { save: () => '' };
  async start(opts: any) {
    if (opts.onError) {
      opts.onError(new Error('TIMEOUT'));
    }
  }
  async sendMessage() {}
  async disconnect() {}
}

jest.mock('telegram', () => ({ TelegramClient: FakeTelegramClient }));

import { initUserbot } from '../src/config/userbot';

test('userbot onError forwards timeout errors', async () => {
  await initUserbot();
  expect(recordTimeoutError).toHaveBeenCalledWith(expect.any(Error));
  expect((recordTimeoutError.mock.calls[0][0] as Error).message).toBe('TIMEOUT');
});
