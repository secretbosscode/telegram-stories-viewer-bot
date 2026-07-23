'use strict';

/**
 * Emergency production guard for Telegram command-menu API floods.
 *
 * PR #310 introduced eager command-scope synchronization across historical
 * users and on live updates. Telegram rate-limits setMyCommands and
 * deleteMyCommands globally for the bot token; once that flood limit is hit,
 * normal sendMessage replies can also be delayed or rejected.
 *
 * This preload suppresses only command-menu maintenance calls. Polling,
 * messages, callbacks, invoices, payments, and all command handlers continue
 * through Telegraf unchanged. Remove this guard after command-menu sync is
 * redesigned as a bounded background job.
 */
const { Telegram } = require('telegraf');

const PATCHED = Symbol.for('telegram-stories.command-menu-flood-guard');
const SUPPRESSED_METHODS = new Set(['setMyCommands', 'deleteMyCommands']);

if (!Telegram.prototype[PATCHED]) {
  const originalCallApi = Telegram.prototype.callApi;
  let warned = false;

  Telegram.prototype.callApi = function guardedCallApi(method, payload, signal) {
    if (SUPPRESSED_METHODS.has(method)) {
      if (!warned) {
        warned = true;
        console.warn(
          '[CommandMenuGuard] Suppressing Telegram command-menu API calls to prevent flood limits.',
        );
      }
      return Promise.resolve(true);
    }

    return originalCallApi.call(this, method, payload, signal);
  };

  Object.defineProperty(Telegram.prototype, PATCHED, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
