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
let startBehaviour: 'ok' | 'fail' = 'ok';
class FakeTelegramClient {
  session: any = { save: () => '' };
  async start() {
    if (startBehaviour === 'fail') throw new Error('connect EHOSTUNREACH 149.154.175.60:80');
  }
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

test('a reconnect that fails fast is retried and counted on every probe until it succeeds', async () => {
  // Probe stalls, and the reconnect it triggers fails immediately: the client
  // is now gone. Previously the probe returned early forever in that state.
  probeBehaviour = 'hang';
  startBehaviour = 'fail';
  await Userbot.runConnectionCheck();
  expect(Userbot.isHealthy()).toBe(false);
  const before = recordTimeoutError.mock.calls.length;

  // Still down: each probe must attempt to re-establish the client and count
  // the failure so the watchdog can reach its threshold.
  await Userbot.runConnectionCheck();
  expect(Userbot.isHealthy()).toBe(false);
  expect(recordTimeoutError.mock.calls.length).toBeGreaterThan(before);
  const last = String((recordTimeoutError.mock.calls.at(-1)?.[0] as Error)?.message);
  expect(last).toMatch(/TIMEOUT/);
  expect(last).toMatch(/EHOSTUNREACH/);

  // Route comes back: the client is re-established and a clean probe restores health.
  startBehaviour = 'ok';
  probeBehaviour = 'ok';
  await Userbot.runConnectionCheck();
  expect(Userbot.isHealthy()).toBe(true);
});
