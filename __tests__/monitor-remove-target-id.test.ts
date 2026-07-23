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
});
