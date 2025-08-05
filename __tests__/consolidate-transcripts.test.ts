jest.mock('../src/config/env-config', () => ({ BOT_ADMIN_ID: 0, BOT_TOKEN: 't', LOG_FILE: '/tmp/test.log' }));

import { consolidateTranscripts } from '../src/lib';

describe('consolidateTranscripts', () => {
  test('merges snippets into a single timeline string', () => {
    const snippets = [
      { date: '2025-08-02', text: 'Second event' },
      { date: '2025-08-01', text: 'First event' },
    ];
    const summary = consolidateTranscripts(snippets);
    expect(summary).toBe('- 2025-08-01 — First event\n- 2025-08-02 — Second event');
  });
});
