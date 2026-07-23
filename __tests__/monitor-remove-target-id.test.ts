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
    expect(notFound).toBeGreaterThan(-1);
    expect(removal).toBeGreaterThan(notFound);
    expect(success).toBeGreaterThan(removal);
  });
});
