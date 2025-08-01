import { jest } from '@jest/globals';

jest.mock('../src/config/userbot', () => ({
  Userbot: { getInstance: jest.fn() },
}));
jest.mock('../src/repositories/user-repository', () => ({
  getPinnedMessageId: jest.fn(),
  setPinnedMessageId: jest.fn(),
  getPinnedMessageUpdatedAt: jest.fn(),
  setPinnedMessageUpdatedAt: jest.fn(),
}));

import { getEntityWithTempContact } from '../src/lib/contacts';
import { Userbot } from '../src/config/userbot';

it('resolves numeric id strings using bigInt', async () => {
  const getEntity = jest.fn(async () => null) as any;
  (Userbot.getInstance as any).mockResolvedValue({ getEntity } as any);

  await getEntityWithTempContact('123456789');

  expect(getEntity).toHaveBeenCalledTimes(1);
  const arg = getEntity.mock.calls[0][0] as any;
  expect(typeof arg).toBe('object');
  expect(arg.toString()).toBe('123456789');
});
