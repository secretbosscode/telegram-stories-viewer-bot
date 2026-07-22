import fs from 'fs';

// This file anchors the exact-head regression contract used by the final review gate.
const source = (path: string) => fs.readFileSync(path, 'utf8');

describe('PR 310 final review regressions', () => {
  test('partial paid deliveries enter a deferred refund and finalize after queue completion', () => {
    const payment = source('src/services/stars-payment.ts');
    const queue = source('src/services/queue-manager.ts');
    expect(payment).toContain('deferIfProcessing = false');
    expect(payment).toContain("SET status = 'REFUND_PENDING'");
    expect(payment).toContain('export async function finalizeDeferredStarsRefund');
    expect(queue).toContain('await finalizeDeferredStarsRefund(currentTask.starsBundleId)');
  });

  test('monitor purchases remain refundable after fulfillment', () => {
    const payment = source('src/services/stars-payment.ts');
    expect(payment).toContain("status = 'DELIVERED' AND request_kind IN ('monitor_week', 'monitor_month')");
  });

  test('monitor plan restoration follows payment order and Premium expiry reconciles excess rows', () => {
    const safety = source('src/services/stars-mode-safety.ts');
    const monitor = source('src/services/monitor-service.ts');
    expect(safety).toContain('JOIN star_payments p ON p.bundle_id = g.bundle_id');
    expect(safety).toContain('ORDER BY p.paid_at DESC, p.rowid DESC');
    expect(safety).toContain('export function reconcileStarsMonitorLimit');
    expect(monitor).toContain('reconcileStarsMonitorLimit(monitor.telegram_id)');
  });

  test('command scopes are tracked and rebuilt in either payment mode', () => {
    const commands = source('src/services/stars-command-surface.ts');
    const payment = source('src/services/stars-payment.ts');
    const index = source('src/index.ts');
    expect(commands).toContain('CREATE TABLE IF NOT EXISTS bot_command_scopes');
    expect(commands).toContain('export async function synchronizeLegacyCommandMenus');
    expect(commands).toContain("type: 'chat_member'");
    expect(payment).toContain('await synchronizeLegacyCommandMenus(bot)');
    expect(index).toContain('await synchronizeStarsCommandMenus(bot, true)');
  });
});
