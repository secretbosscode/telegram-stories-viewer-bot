import { jest } from '@jest/globals';
jest.mock('../src/controllers/send-message', () => ({ notifyAdmin: jest.fn() }));
import { db } from '../src/db';
import { refreshUserUsername } from '../src/repositories/user-repository';

test('refreshUserUsername updates stored username when it changes', async () => {
  db.prepare("INSERT INTO users (telegram_id, username) VALUES ('1', 'old')").run();
  const telegram = { getChat: jest.fn(async () => ({ username: 'new' })) } as any;
  const updated = await refreshUserUsername(telegram as any, { telegram_id: '1', username: 'old' });
  expect(updated).toBe('new');
  const row = db.prepare('SELECT username FROM users WHERE telegram_id = ?').get('1') as any;
  expect(row.username).toBe('new');
  db.prepare('DELETE FROM users WHERE telegram_id = ?').run('1');
});

test('refreshUserUsername keeps username if unchanged', async () => {
  db.prepare("INSERT INTO users (telegram_id, username) VALUES ('2', 'same')").run();
  const telegram = { getChat: jest.fn(async () => ({ username: 'same' })) } as any;
  const updated = await refreshUserUsername(telegram as any, { telegram_id: '2', username: 'same' });
  expect(updated).toBe('same');
  const row = db.prepare('SELECT username FROM users WHERE telegram_id = ?').get('2') as any;
  expect(row.username).toBe('same');
  db.prepare('DELETE FROM users WHERE telegram_id = ?').run('2');
});
