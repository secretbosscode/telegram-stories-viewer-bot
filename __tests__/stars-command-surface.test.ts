import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(
  path.join(__dirname, '../src/services/stars-command-surface.ts'),
  'utf8',
);

describe('Stars command surface', () => {
  test('ordinary Stars menu excludes obsolete BTC, Premium, trial, and referral commands', () => {
    const baseBlock = source.match(/function getStarsBaseCommands[\s\S]*?\n}\n/)?.[0] ?? '';
    expect(baseBlock).toContain("command: 'monitor'");
    expect(baseBlock).toContain("command: 'unmonitor'");
    expect(baseBlock).toContain("command: 'paysupport'");
    expect(baseBlock).not.toContain("command: 'verify'");
    expect(baseBlock).not.toContain("command: 'upgrade'");
    expect(baseBlock).not.toContain("command: 'premium'");
    expect(baseBlock).not.toContain("command: 'freetrial'");
    expect(baseBlock).not.toContain("command: 'invite'");
  });

  test('typed commands are checked against the same menu whitelist', () => {
    expect(source).toContain('allowedCommandNames(locale, userId).has(command)');
    expect(source).toContain("t(locale, 'stars.commandUnavailable')");
  });

  test('Stars start intercepts the legacy referral-aware start handler', () => {
    expect(source).toContain("if (command === 'start') return renderStarsStart(ctx, bot)");
  });

  test('paused story requests are rejected before entering legacy handlers', () => {
    expect(source).toContain('!areStarsEnabled()');
    expect(source).toContain("t(locale, 'stars.requestPaused')");
  });

  test('only the week and month monitoring plans are offered', () => {
    expect(source).toContain("callback_data: 'starsmonitor:buy:week'");
    expect(source).toContain("callback_data: 'starsmonitor:buy:month'");
    expect(source).not.toContain('monitor_day');
    expect(source).not.toContain('monitor_year');
  });

  test('group command menus are scoped to the requesting member', () => {
    expect(source).toContain("type: 'chat_member'");
    expect(source).toContain('user_id: numericUserId');
    expect(source).not.toContain("scope: { type: 'chat', chat_id: Number(chatId) }");
  });


  test('BTC mode preserves controls for active Stars monitoring customers', () => {
    expect(source).toContain('const paidMonitoring = Boolean(userId && getStarsMonitoringEntitlement(userId))');
    expect(source).toContain("if (paidMonitoring && command === 'monitor')");
    expect(source).toContain("if (paidMonitoring && command === 'unmonitor')");
    expect(source).toContain('commands.push(...getLegacyMonitoringCommands(locale))');
  });

  test('administrators can tune both monitoring prices without environment changes', () => {
    expect(source).toContain("command: 'setmonitorprice'");
    expect(source).toContain("setStarsMonitorPrice(plan, value, String(ctx.from.id))");
    expect(source).toContain('Usage: /setmonitorprice <week|month> <1-10000>');
  });

  test('Stars-mode /start still credits referrals through the shared referral service', () => {
    expect(source).toContain("import { processStartReferral } from './referral-service'");
    const startBlock = source.match(/async function renderStarsStart[\s\S]*?\n}\n/)?.[0] ?? '';
    expect(startBlock).toContain('processStartReferral(ctx.telegram, userId');
    // It parses the invite code out of the raw "/start <payload>" text.
    expect(startBlock).toContain('const payloadMatch = startText.match(');
    expect(startBlock).toContain('payloadMatch?.[1]?.trim()');
  });

  test('legacy group menus are cleared lazily even when the migration cannot discover them', () => {
    // Telegram exposes no API to enumerate historical command scopes, so the
    // one-shot migration alone cannot be complete for groups.
    expect(source).toContain('CREATE TABLE IF NOT EXISTS legacy_group_scopes');
    expect(source).toContain('async function clearLegacyGroupScope');
    // The middleware safety net runs before the command branches so every
    // group interaction clears the stale menu once.
    expect(source).toContain('if (chatId) await clearLegacyGroupScope(bot, chatId)');
    const clearBlock = source.match(/async function clearLegacyGroupScope[\s\S]*?\n}\n/)?.[0] ?? '';
    expect(clearBlock).toContain("scope: { type: 'chat', chat_id: numericChatId }");
    expect(clearBlock).toContain('INSERT OR IGNORE INTO legacy_group_scopes');
    // A failed delete returns before recording, so it is retried next time.
    expect(clearBlock).toContain('return;');
  });

  test('the scope migration also enumerates observed groups and records what it clears', () => {
    const migrationBlock = source.match(/async function migrateExistingCommandScopes[\s\S]*?\n}\n/)?.[0] ?? '';
    expect(migrationBlock).toContain('FROM bot_command_scopes');
    expect(migrationBlock).toContain('INSERT OR IGNORE INTO legacy_group_scopes');
  });
});
