import fs from 'fs';

describe('command menu flood guard', () => {
  test('suppresses only command-menu API calls', async () => {
    jest.resetModules();
    const telegraf = require('telegraf');
    const originalCallApi = jest.fn().mockResolvedValue({ ok: true });
    telegraf.Telegram.prototype.callApi = originalCallApi;

    require('../command-menu-flood-guard.js');

    const telegram = new telegraf.Telegram('test-token');
    await telegram.callApi('setMyCommands', { commands: [] });
    await telegram.callApi('deleteMyCommands', {});

    expect(originalCallApi).not.toHaveBeenCalled();

    const payload = { chat_id: 123, text: 'alive' };
    await telegram.callApi('sendMessage', payload);

    expect(originalCallApi).toHaveBeenCalledTimes(1);
    expect(originalCallApi).toHaveBeenCalledWith('sendMessage', payload, undefined);
  });

  test('production entrypoints preload the guard', () => {
    const ecosystem = fs.readFileSync('ecosystem.config.js', 'utf8');
    const dockerfile = fs.readFileSync('Dockerfile', 'utf8');

    expect(ecosystem).toContain('--require ./command-menu-flood-guard.js');
    expect(dockerfile).toContain(
      'CMD ["node", "--require", "./command-menu-flood-guard.js", "dist/index.js"]',
    );
  });
});
