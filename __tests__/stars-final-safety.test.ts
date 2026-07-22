import fs from 'fs';

const source = (path: string) => fs.readFileSync(path, 'utf8');

describe('final Stars safety invariants', () => {
  test('paid recovery is independent of checkout mode', () => {
    const text = source('src/services/stars-payment.ts');
    expect(text).toContain('export async function recoverPaidBundles');
    expect(text).toContain('if (recoveryRunning || !botInstance) return;');
    expect(text).not.toContain('recoveryRunning || !botInstance || !isStarsMode()');
  });

  test('paid and monitored active delivery bypass pagination and preserve partial IDs', () => {
    const text = source('src/controllers/send-active-stories.ts');
    expect(text).toContain('task.starsBundleId || (task as any).monitorDelivery');
    expect(text).toContain('return partialIds');
    expect(text).toContain('new PartialStoryDeliveryError(error, partialIds)');
  });

  test('paid monitoring uses the existing stoppable scheduler', () => {
    const monitor = source('src/services/monitor-service.ts');
    const safety = source('src/services/stars-mode-safety.ts');
    expect(monitor).toContain('getStarsMonitoringEntitlement(monitor.telegram_id)');
    expect(monitor.match(/monitorDelivery: true/g)?.length).toBe(2);
    expect(safety).not.toContain('startStarsMonitorLoop');
    expect(safety).not.toContain('runStarsMonitorCycle');
  });

  test('refunds reconcile monitor rows and command migration clears group scopes', () => {
    const safety = source('src/services/stars-mode-safety.ts');
    const commands = source('src/services/stars-command-surface.ts');
    expect(safety).toContain('DELETE FROM monitors');
    expect(commands).toContain('stars_command_scope_v4');
    expect(commands).toContain("callApi('deleteMyCommands'");
    expect(commands).toContain("type: 'chat_member'");
  });

  test('Stars menus cannot be overwritten by legacy startup or per-user updates', () => {
    const index = source('src/index.ts');
    expect(index).toContain("import { isStarsMode } from './services/stars-payment'");
    expect(index).toContain('if (isStarsMode()) return;');
    expect(index).toContain('if (!isStarsMode()) {');
  });

  test('switching to Stars forces an immediate command-menu rebuild', () => {
    const payment = source('src/services/stars-payment.ts');
    const commands = source('src/services/stars-command-surface.ts');
    expect(commands).toContain('export async function synchronizeStarsCommandMenus');
    expect(commands).toContain('migrateExistingCommandScopes(bot, force)');
    expect(payment).toContain('await synchronizeStarsCommandMenus(bot, true)');
  });

  test('monitor limits are atomic and Premium eligibility survives Stars refunds', () => {
    const safety = source('src/services/stars-mode-safety.ts');
    const commands = source('src/services/stars-command-surface.ts');
    expect(safety).toContain('CREATE TRIGGER enforce_star_monitor_limit');
    expect(safety).toContain("RAISE(ABORT, 'STAR_MONITOR_LIMIT')");
    expect(safety.match(/COALESCE\(u\.is_premium, 0\) = 1/g)?.length).toBeGreaterThanOrEqual(3);
    expect(commands).toContain("String(error).includes('STAR_MONITOR_LIMIT')");
  });

  // Paid media must never be sent after a bundle enters refund fencing.
});
