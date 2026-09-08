import fs from 'fs';

describe('monitor removal target resolution', () => {
  test('the shared removal service accepts username-less target IDs', () => {
    const source = fs.readFileSync('src/services/monitor-service.ts', 'utf8');
    const removal = source.match(
      /export async function removeProfileMonitor[\s\S]*?\n}\n/,
    )?.[0] ?? '';

    expect(removal).toContain('findMonitorByUsername(telegramId, target)');
    expect(removal).toContain(
      'listMonitors(telegramId).find((monitor) => monitor.target_id === target)',
    );
    expect(removal).toContain('removeMonitor(telegramId, existing.target_id)');
  });

  test('Stars unmonitor rejects missing targets before reporting success', () => {
    const source = fs.readFileSync('src/services/stars-command-surface.ts', 'utf8');
    const handler = source.match(
      /async function handleStarsUnmonitor[\s\S]*?\n}\n/,
    )?.[0] ?? '';

    const notFound = handler.indexOf("t(locale, 'stories.userNotFound'");
    const removal = handler.indexOf('removeProfileMonitor(userId, existing.target_id)');
    const success = handler.indexOf("t(locale, 'stars.monitorStopped'");

    expect(handler).toContain('if (!existing)');
    // An alias that is not the stored handle goes through the shared removal
    // path, which resolves it to the account id, before "not found" is sent.
    expect(handler).toContain('removeProfileMonitor(userId, target)');
    expect(notFound).toBeGreaterThan(-1);
    expect(removal).toBeGreaterThan(notFound);
    expect(success).toBeGreaterThan(removal);
  });
});
