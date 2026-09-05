import {
  db,
  recordProfileRequest,
  wasProfileRequestedRecently,
  getProfileRequestCooldownRemaining,
} from '../src/db';

const USER = 'cooldown-user';

afterAll(() => {
  db.prepare('DELETE FROM profile_requests WHERE telegram_id = ?').run(USER);
});

test('the remaining-cooldown lookup matches the same normalized key as the check', () => {
  db.prepare('DELETE FROM profile_requests WHERE telegram_id = ?').run(USER);
  recordProfileRequest(USER, '@Alice');
  expect(wasProfileRequestedRecently(USER, 'ALICE', 12)).toBe(true);
  // Previously this compared the raw input and reported zero, so the user was
  // told they were blocked with no time remaining.
  expect(getProfileRequestCooldownRemaining(USER, 'ALICE', 12)).toBeGreaterThan(0);
  expect(getProfileRequestCooldownRemaining(USER, '@alice', 12)).toBeGreaterThan(0);
});
