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
});
