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

import { addMonitor, getMonitor } from '../src/db';
import { isUserPremium } from '../src/services/premium-service';

const monitorService = require('../src/services/monitor-service');

test('removes monitor when user is not premium', async () => {
  const row = addMonitor('user', '123', 'tester', null, null);
  (isUserPremium as jest.Mock).mockReturnValue(false);

  const spy = jest.spyOn(monitorService, 'checkSingleMonitor');

  await monitorService.forceCheckMonitors();

  expect(spy).not.toHaveBeenCalled();
  expect(getMonitor(row.id)).toBeUndefined();
});

