import { Api } from 'telegram';
import { Userbot } from 'config/userbot';
import { STEALTH_MODE_ENABLED } from 'config/env-config';

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
let floodWaitUntil: number | null = null;
let lastFloodLogAt: number | null = null;

export type StealthModeOptions = {
  past?: boolean;
  force?: boolean;
};

export async function ensureStealthMode(options: StealthModeOptions = {}): Promise<boolean> {
  if (!STEALTH_MODE_ENABLED) {
    return false;
  }

  if (premiumUnavailable) {
    return false;
  }

  const { past = false, force = false } = options;
  const now = Date.now();

  if (floodWaitUntil && now >= floodWaitUntil) {
    floodWaitUntil = null;
    lastFloodLogAt = null;
  }

  if (floodWaitUntil && now < floodWaitUntil) {
    if (!lastFloodLogAt || now - lastFloodLogAt > 60_000) {
      const remainingSeconds = Math.ceil((floodWaitUntil - now) / 1000);
      console.warn(
        `[StealthMode] Skipping activation due to flood wait. Retry in ${remainingSeconds}s.`,
      );
      lastFloodLogAt = now;
    }
    return false;
  }

  const state = past ? pastState : futureState;
  const ttl = past ? STEALTH_PAST_WINDOW_MS : STEALTH_WINDOW_MS;

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
      const floodSeconds = getFloodWaitSeconds(error);
      if (floodSeconds) {
        floodWaitUntil = Date.now() + floodSeconds * 1000;
        lastFloodLogAt = Date.now();
        console.warn(
          `[StealthMode] Flood wait for ${floodSeconds}s. Stealth activation paused until ${new Date(
            floodWaitUntil,
          ).toISOString()}.`,
        );
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
  floodWaitUntil = null;
  lastFloodLogAt = null;
}

function getFloodWaitSeconds(error: any): number | null {
  if (typeof error?.seconds === 'number' && Number.isFinite(error.seconds)) {
    return error.seconds;
  }

  const message: string | undefined = error?.errorMessage || error?.message;
  if (!message) {
    return null;
  }

  const directMatch = message.match(/A wait of (\d+) seconds is required/i);
  if (directMatch) {
    return Number(directMatch[1]);
  }

  const suffixMatch = message.match(/FLOOD_WAIT_(\d+)/i);
  if (suffixMatch) {
    return Number(suffixMatch[1]);
  }

  return null;
}
