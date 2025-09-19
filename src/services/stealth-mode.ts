import { Api } from 'telegram';
import { Userbot } from 'config/userbot';

const STEALTH_WINDOW_MS = 25 * 60 * 1000; // 25 minutes
const STEALTH_PAST_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

type ActivationState = {
  lastActivatedAt: number | null;
  inflight: Promise<boolean> | null;
};

const futureState: ActivationState = {
  lastActivatedAt: null,
  inflight: null,
};

const pastState: ActivationState = {
  lastActivatedAt: null,
  inflight: null,
};

let premiumUnavailable = false;

export type StealthModeOptions = {
  past?: boolean;
  force?: boolean;
};

export async function ensureStealthMode(options: StealthModeOptions = {}): Promise<boolean> {
  if (premiumUnavailable) {
    return false;
  }

  const { past = false, force = false } = options;
  const state = past ? pastState : futureState;
  const ttl = past ? STEALTH_PAST_WINDOW_MS : STEALTH_WINDOW_MS;

  const now = Date.now();
  if (!force && state.lastActivatedAt && now - state.lastActivatedAt < ttl) {
    return false;
  }

  if (state.inflight) {
    return state.inflight;
  }

  state.inflight = (async () => {
    try {
      const client = await Userbot.getInstance();
      const request = new Api.stories.ActivateStealthMode({
        future: true,
        ...(past ? { past: true } : {}),
      });
      await client.invoke(request);
      const activatedAt = Date.now();
      state.lastActivatedAt = activatedAt;
      if (past) {
        futureState.lastActivatedAt = activatedAt;
      }
      return true;
    } catch (error: any) {
      const errorMessage: string | undefined = error?.errorMessage || error?.message;
      if (errorMessage && errorMessage.includes('PREMIUM_ACCOUNT_REQUIRED')) {
        premiumUnavailable = true;
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[StealthMode] Premium required to activate stealth mode. Continuing without it.');
        }
        return false;
      }
      console.error('[StealthMode] Failed to activate stealth mode:', error);
      return false;
    } finally {
      state.inflight = null;
    }
  })();

  return state.inflight;
}

export function resetStealthState(): void {
  futureState.lastActivatedAt = null;
  pastState.lastActivatedAt = null;
  premiumUnavailable = false;
}
