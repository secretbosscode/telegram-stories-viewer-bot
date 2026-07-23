import { jest } from '@jest/globals';

const mockFindInviterByCode = jest.fn<(code: string) => string | undefined>();
const mockGetInviterForUser = jest.fn<(userId: string) => string | undefined>();
const mockRecordReferral = jest.fn();
const mockCountReferrals = jest.fn<(inviter: string) => number>();
const mockExtendPremium = jest.fn();
const mockFindUserById = jest.fn<(id: string) => { language?: string } | undefined>();

jest.mock('../src/db', () => ({
  findInviterByCode: (code: string) => mockFindInviterByCode(code),
  getInviterForUser: (userId: string) => mockGetInviterForUser(userId),
  recordReferral: (inviter: string, newUser: string) => mockRecordReferral(inviter, newUser),
  countReferrals: (inviter: string) => mockCountReferrals(inviter),
}));
jest.mock('../src/services/premium-service', () => ({
  extendPremium: (id: string, days: number) => mockExtendPremium(id, days),
}));
jest.mock('../src/repositories/user-repository', () => ({
  findUserById: (id: string) => mockFindUserById(id),
}));
jest.mock('../src/lib/i18n', () => ({ t: (_locale: string, key: string) => key }));

import { processStartReferral } from '../src/services/referral-service';

describe('processStartReferral (Stars-mode referral parity)', () => {
  const sendMessage = jest.fn<(chatId: string, text: string) => Promise<unknown>>();
  const telegram = { sendMessage } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindInviterByCode.mockReturnValue('111');
    mockGetInviterForUser.mockReturnValue(undefined);
    mockCountReferrals.mockReturnValue(1);
    mockFindUserById.mockReturnValue({ language: 'en' });
    sendMessage.mockResolvedValue(undefined);
  });

  test('records a referral for a valid invite payload', async () => {
    await processStartReferral(telegram, '222', 'INVITE');
    expect(mockFindInviterByCode).toHaveBeenCalledWith('INVITE');
    expect(mockGetInviterForUser).toHaveBeenCalledWith('222');
    expect(mockRecordReferral).toHaveBeenCalledWith('111', '222');
  });

  test('ignores an empty or missing payload', async () => {
    await processStartReferral(telegram, '222', undefined);
    await processStartReferral(telegram, '222', '   ');
    expect(mockFindInviterByCode).not.toHaveBeenCalled();
    expect(mockRecordReferral).not.toHaveBeenCalled();
  });

  test('does not self-refer when the invite belongs to the joining user', async () => {
    mockFindInviterByCode.mockReturnValue('222');
    await processStartReferral(telegram, '222', 'INVITE');
    expect(mockRecordReferral).not.toHaveBeenCalled();
  });

  test('does nothing when the invite code is unknown', async () => {
    mockFindInviterByCode.mockReturnValue(undefined);
    await processStartReferral(telegram, '222', 'INVITE');
    expect(mockRecordReferral).not.toHaveBeenCalled();
    expect(mockExtendPremium).not.toHaveBeenCalled();
  });

  test('does not re-award an existing referral milestone', async () => {
    mockGetInviterForUser.mockReturnValue('111');
    mockCountReferrals.mockReturnValue(5);

    await processStartReferral(telegram, '222', 'INVITE');

    expect(mockRecordReferral).not.toHaveBeenCalled();
    expect(mockCountReferrals).not.toHaveBeenCalled();
    expect(mockExtendPremium).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('grants the inviter the five-referral Premium reward', async () => {
    mockCountReferrals.mockReturnValue(5);
    await processStartReferral(telegram, '222', 'INVITE');
    expect(mockExtendPremium).toHaveBeenCalledWith('111', 7);
    expect(sendMessage).toHaveBeenCalledWith('111', 'referral.fiveUsers');
  });

  test('does not grant the reward below the five-referral threshold', async () => {
    mockCountReferrals.mockReturnValue(4);
    await processStartReferral(telegram, '222', 'INVITE');
    expect(mockExtendPremium).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
