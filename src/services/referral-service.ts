import type { Telegram } from 'telegraf';
import {
  countReferrals,
  findInviterByCode,
  getInviterForUser,
  recordReferral,
} from 'db';
import { db } from 'db';
import { t } from 'lib/i18n';
import { findUserById } from '../repositories/user-repository';
import { extendPremium } from './premium-service';

function usesStarsPayments(): boolean {
  try {
    const row = db
      .prepare("SELECT value FROM bot_settings WHERE key = 'payment_mode'")
      .get() as { value?: string } | undefined;
    return row?.value === 'stars';
  } catch {
    return false;
  }
}

/**
 * Records a referral for a `/start <invite-code>` join and applies the
 * established five-referral Premium reward. Shared by the legacy `bot.start`
 * handler and the Stars-mode `/start` renderer so both checkout modes retain
 * identical referral behavior.
 */
export async function processStartReferral(
  telegram: Telegram,
  newUserId: string,
  payload: string | undefined,
): Promise<void> {
  const code = String(payload || '').trim();
  if (!code) return;

  const inviter = findInviterByCode(code);
  if (!inviter || inviter === newUserId) return;

  // referrals.new_user_id is unique. Check before the synchronous insert so a
  // repeated /start payload cannot re-award an already reached milestone.
  if (getInviterForUser(newUserId)) return;
  recordReferral(inviter, newUserId);

  const total = countReferrals(inviter);
  if (total % 5 === 0) {
    // Stars mode sells results per bundle and Premium bypasses that paywall
    // entirely, so granting Premium here handed out the paid product for free
    // to anyone with five throwaway accounts. Premium rewards stay in the
    // legacy BTC mode only, matching grantFreeTrial's behaviour.
    if (usesStarsPayments()) return;
    extendPremium(inviter, 7);
    try {
      const inviterLang = findUserById(inviter)?.language;
      await telegram.sendMessage(inviter, t(inviterLang, 'referral.fiveUsers'));
    } catch {
      // Best-effort notification; the reward has already been applied.
    }
  }
}
