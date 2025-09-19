import { jest } from '@jest/globals';
import { Api } from 'telegram';
import bigInt from 'big-integer';

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

it('uses contacts.ResolvePhone for phone numbers', async () => {
  const phone = '+1234567890';
  const userId = bigInt(42);
  const accessHash = bigInt(84);

  const user = new Api.User({
    id: userId,
    accessHash,
    firstName: 'Test',
    lastName: 'User',
    phone: phone.replace('+', ''),
    self: false,
    contact: false,
    mutualContact: false,
    deleted: false,
    bot: false,
    botChatHistory: false,
    botNochats: false,
    verified: false,
    restricted: false,
    min: false,
    scam: false,
    fake: false,
    support: false,
  });

  const resolved = new Api.contacts.ResolvedPeer({
    peer: new Api.PeerUser({ userId }),
    chats: [],
    users: [user],
  });

  const invoke = jest.fn(async (request: any) => {
    if (request instanceof Api.contacts.ResolvePhone) {
      return resolved;
    }
    if (request instanceof Api.users.GetUsers) {
      return [user];
    }
    throw new Error(`Unexpected request: ${request?.constructor?.name}`);
  });

  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const result = await getEntityWithTempContact(phone);

  expect(invoke.mock.calls[0][0]).toBeInstanceOf(Api.contacts.ResolvePhone);
  expect(result).toBe(user);
});

it('falls back to importing contacts when resolve fails with PHONE_NOT_OCCUPIED', async () => {
  const phone = '+19876543210';
  const userId = bigInt(777);
  const accessHash = bigInt(999);

  const importedUser = new Api.User({
    id: userId,
    accessHash,
    firstName: 'Imported',
    lastName: 'User',
    phone: phone.replace('+', ''),
    self: false,
    contact: false,
    mutualContact: false,
    deleted: false,
    bot: false,
    botChatHistory: false,
    botNochats: false,
    verified: false,
    restricted: false,
    min: false,
    scam: false,
    fake: false,
    support: false,
  });

  const importedContacts = new Api.contacts.ImportedContacts({
    imported: [
      new Api.ImportedContact({
        userId,
        clientId: bigInt.zero,
      }),
    ],
    popularInvites: [],
    retryContacts: [],
    users: [importedUser],
  });

  const deleteSpy = jest.fn();

  const invoke = jest.fn(async (request: any) => {
    if (request instanceof Api.contacts.ResolvePhone) {
      const error: any = new Error('PHONE_NOT_OCCUPIED');
      error.errorMessage = 'PHONE_NOT_OCCUPIED';
      throw error;
    }
    if (request instanceof Api.contacts.ImportContacts) {
      return importedContacts;
    }
    if (request instanceof Api.users.GetUsers) {
      return [importedUser];
    }
    if (request instanceof Api.contacts.DeleteContacts) {
      deleteSpy();
      return true;
    }
    throw new Error(`Unexpected request: ${request?.constructor?.name}`);
  });

  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const result = await getEntityWithTempContact(phone);

  expect(result).toBe(importedUser);
  expect(deleteSpy).toHaveBeenCalledTimes(1);
});
