import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';

jest.mock('../src/config/env-config', () => ({
  BOT_ADMIN_ID: 0,
  BOT_TOKEN: 'token',
  LOG_FILE: '/tmp/test.log',
}));

const sendTemporaryMessage = jest.fn();
jest.mock('../src/lib/helpers.ts', () => ({
  ...(jest.requireActual('../src/lib/helpers.ts') as any),
  sendTemporaryMessage,
}));

const notifyAdmin = jest.fn();
jest.mock('../src/controllers/send-message', () => ({ notifyAdmin }));

const mockGetInstance = jest.fn();
jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: mockGetInstance },
}));

const bot = { telegram: { sendMediaGroup: jest.fn(), sendMessage: jest.fn() } } as any;
jest.mock('../src/index.ts', () => ({ bot }));

class Photo {}
jest.mock('telegram', () => ({
  Api: {
    photos: {
      GetUserPhotos: class GetUserPhotos {},
    },
    Photo,
  },
}));

import { sendProfileMedia } from '../src/controllers/send-profile-media';

describe('sendProfileMedia', () => {
  test('sends all media in chunks', async () => {
    const photos = Array.from({ length: 11 }, () => new Photo());
    const fakeClient: any = {
      getEntity: async () => 'e',
      invoke: async () => ({ photos }),
      downloadMedia: async () => Buffer.from('x'),
    };
    (mockGetInstance as any).mockResolvedValue(fakeClient);

    await sendProfileMedia(1, '@user');

    expect(bot.telegram.sendMediaGroup).toHaveBeenCalledTimes(2);
    const total = (bot.telegram.sendMediaGroup as jest.Mock).mock.calls
      .reduce((sum: number, c: any[]) => sum + c[1].length, 0);
    expect(total).toBe(11);
    expect(sendTemporaryMessage).toHaveBeenCalledTimes(1);
    expect(sendTemporaryMessage).toHaveBeenCalledWith(
      bot,
      1,
      '📸 Sent 11 profile media item(s) of @user',
    );
  });
});
