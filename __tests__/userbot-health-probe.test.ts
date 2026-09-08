import { jest } from '@jest/globals';

// Must be set before the module under test is imported.
process.env.USERBOT_PROBE_TIMEOUT_MS = '30';
process.env.USERBOT_RECONNECT_TIMEOUT_MS = '60';

jest.mock('../src/config/env-config', () => ({
  USERBOT_API_HASH: 'h',
  USERBOT_API_ID: 1,
  USERBOT_PHONE_NUMBER: '+1',
  USERBOT_PASSWORD: '',
  USERBOT_PHONE_CODE: '',
}));

const recordTimeoutError = jest.fn();
jest.mock('../src/config/timeout-monitor', () => ({ recordTimeoutError }));

let probeBehaviour: 'hang' | 'ok' = 'hang';
class FakeTelegramClient {
  session: any = { save: () => '' };
  async start() {}
  async sendMessage() {}
  async disconnect() {}
  invoke() {
    return probeBehaviour === 'hang' ? new Promise(() => undefined) : Promise.resolve({});
  }
}
jest.mock('telegram', () => ({
  TelegramClient: FakeTelegramClient,
  Api: { updates: { GetState: class GetState {} } },
}));

import { initUserbot, Userbot } from '../src/config/userbot';

afterAll(() => Userbot.stopConnectionMonitor());

test('a probe that never answers is counted as a failure and marks the connection unhealthy', async () => {
  await initUserbot();
  expect(Userbot.isHealthy()).toBe(true);

  await Userbot.runConnectionCheck();

  expect(Userbot.isHealthy()).toBe(false);
  const messages = recordTimeoutError.mock.calls.map((c: any[]) => String((c[0] as Error)?.message ?? c[0]));
  expect(messages.some((m) => /probe TIMEOUT/.test(m))).toBe(true);
});

test('the connection is healthy again only after a probe succeeds', async () => {
  probeBehaviour = 'ok';
  await Userbot.runConnectionCheck();
  expect(Userbot.isHealthy()).toBe(true);
});
