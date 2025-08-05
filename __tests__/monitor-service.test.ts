import { jest } from '@jest/globals';

jest.mock('config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  PROD_BOT_TOKEN: 'token',
  USERBOT_SESSION: '',
}));

jest.mock('index', () => ({
  bot: { telegram: { sendMessage: jest.fn(), sendPhoto: jest.fn(), sendVideo: jest.fn(), sendMediaGroup: jest.fn() } },
  LOG_FILE: '/tmp/test.log',
}));

const addMonitor: jest.Mock = jest.fn();
const findMonitorByUsername: jest.Mock = jest.fn();

jest.mock('../src/db', () => ({
  addMonitor: (telegram_id: string, target_id: string, target_username: string, accessHash?: string) =>
    addMonitor(telegram_id, target_id, target_username, accessHash),
  findMonitorByUsername: (telegram_id: string, username: string) =>
    findMonitorByUsername(telegram_id, username),
}));

const getEntityWithTempContact = jest.fn() as jest.Mock;
jest.mock('../src/lib/index.ts', () => ({
  getEntityWithTempContact: (username: string) => getEntityWithTempContact(username),
}));

import { addProfileMonitor } from '../src/services/monitor-service';

describe('addProfileMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes username before lookup and add', async () => {
    findMonitorByUsername.mockReturnValue(undefined);
    getEntityWithTempContact.mockImplementation(async () => ({ id: 1, accessHash: 'hash', username: 'TestUser' }));
    addMonitor.mockReturnValue({ id: 1 });

    await addProfileMonitor('123', '@TestUser');

    expect(findMonitorByUsername).toHaveBeenCalledWith('123', 'testuser');
    expect(getEntityWithTempContact).toHaveBeenCalledWith('testuser');
    expect(addMonitor).toHaveBeenCalledWith('123', '1', 'testuser', 'hash');
  });

  test('returns null when monitor already exists (case-insensitive)', async () => {
    findMonitorByUsername.mockReturnValue({ id: 1 });

    const res = await addProfileMonitor('123', 'TestUser');

    expect(res).toBeNull();
    expect(addMonitor).not.toHaveBeenCalled();
  });
});

