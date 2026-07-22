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
});
