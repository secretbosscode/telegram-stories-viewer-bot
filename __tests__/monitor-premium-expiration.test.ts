import { jest } from '@jest/globals';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));
jest.mock('../src/index', () => ({
  bot: { telegram: { sendMessage: jest.fn(), sendPhoto: jest.fn(), sendVideo: jest.fn() } },
}));
jest.mock('../src/lib/i18n', () => ({
  t: jest.fn(() => ''),
}));
jest.mock('../src/controllers/send-active-stories', () => ({
  sendActiveStories: jest.fn(),
}));
jest.mock('../src/controllers/download-stories', () => ({
  mapStories: jest.fn(() => []),
}));
jest.mock('../src/lib', () => ({
  getEntityWithTempContact: jest.fn(),
}));
jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  LOG_FILE: '/tmp/test.log',
}));
jest.mock('../src/repositories/user-repository', () => ({
  findUserById: jest.fn(() => ({ language: 'en' })),
}));
jest.mock('../src/services/premium-service', () => ({
  isUserPremium: jest.fn(),
}));

const getStarsMonitoringEntitlement = jest.fn();
const authorizeStarsMonitorRemoval = jest.fn();
const clearStarsMonitorRemovalAuthorization = jest.fn();
jest.mock('../src/services/stars-mode-safety', () => ({
  getStarsMonitoringEntitlement,
  authorizeStarsMonitorRemoval,
  clearStarsMonitorRemovalAuthorization,
}));

import { addMonitor, getMonitor } from '../src/db';
import { isUserPremium } from '../src/services/premium-service';

const monitorService = require('../src/services/monitor-service');

afterEach(() => {
  monitorService.stopMonitorLoop();
  jest.clearAllMocks();
});

test('removes monitor when user is not premium', async () => {
  const row = addMonitor('user', '123', 'tester', null, null);
  (isUserPremium as jest.Mock).mockReturnValue(false);

  const spy = jest.spyOn(monitorService, 'checkSingleMonitor');

  await monitorService.forceCheckMonitors();

  expect(spy).not.toHaveBeenCalled();
  expect(getMonitor(row.id)).toBeUndefined();
});

test('explicit removal is authorized when paid monitoring and Premium overlap', async () => {
  const row = addMonitor('premium-user', '456', 'tester2', null, null);
  getStarsMonitoringEntitlement.mockReturnValue({
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    maxTargets: 3,
    plan: 'monitor_week',
  });

  await monitorService.removeProfileMonitor('premium-user', 'tester2');

  expect(authorizeStarsMonitorRemoval).toHaveBeenCalledWith('premium-user', '456');
  expect(clearStarsMonitorRemovalAuthorization).toHaveBeenCalledWith('premium-user', '456');
  expect(getMonitor(row.id)).toBeUndefined();
});
