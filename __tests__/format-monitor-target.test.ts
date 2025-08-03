import { jest } from '@jest/globals';

jest.mock('../src/config/env-config', () => ({ BOT_ADMIN_ID: 0, LOG_FILE: '/tmp/test.log' }));
jest.mock('../src/config/userbot', () => ({ Userbot: { getInstance: jest.fn() } }));
jest.mock('../src/lib', () => ({ getEntityWithTempContact: jest.fn() }));
jest.mock('controllers/send-active-stories', () => ({ sendActiveStories: jest.fn() }));
jest.mock('controllers/download-stories', () => ({ mapStories: jest.fn(() => []) }));

import { formatMonitorTarget } from '../src/services/monitor-service';

describe('formatMonitorTarget', () => {
  test('prefixes @ for usernames', () => {
    const row: any = { target_username: 'john', target_id: '123' };
    expect(formatMonitorTarget(row)).toBe('@john');
  });

  test('does not prefix @ for phone numbers', () => {
    const row: any = { target_username: '+123456789', target_id: '123' };
    expect(formatMonitorTarget(row)).toBe('+123456789');
  });

  test('uses id when username missing', () => {
    const row: any = { target_username: null, target_id: '456' };
    expect(formatMonitorTarget(row)).toBe('456');
  });
});
