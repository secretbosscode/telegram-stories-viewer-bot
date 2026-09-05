import {
  db,
  addMonitor,
  removeMonitor,
  markStorySent,
  listSentStoryKeys,
  listSentStoryKeysAmong,
  pruneOrphanedSentStories,
} from '../src/db';

const ORPHAN_MONITOR_ID = 987654321;

afterAll(() => {
  db.prepare('DELETE FROM monitor_sent_stories WHERE monitor_id = ?').run(ORPHAN_MONITOR_ID);
});

test('removing a monitor removes its delivery records', () => {
  const row = addMonitor('retention-user', '31337', 'kept', '999', null);
  markStorySent(row.id, 1, 10, 0, 'active');
  markStorySent(row.id, 2, 20, 0, 'pinned');
  expect(listSentStoryKeysAmong(row.id, ['1:10', '2:20', '3:30'])).toEqual(
    expect.arrayContaining(['1:10', '2:20']),
  );
  removeMonitor('retention-user', '31337');
  expect(listSentStoryKeys(row.id, 'pinned')).toEqual([]);
  expect(listSentStoryKeysAmong(row.id, ['1:10', '2:20'])).toEqual([]);
});

test('maintenance prunes records of monitors that no longer exist and keeps the rest', () => {
  const live = addMonitor('retention-live', '31338', 'live', '999', null);
  // An expired active delivery on a live monitor is evidence, not garbage.
  markStorySent(live.id, 5, 50, 1, 'active');
  db.prepare(
    `INSERT OR REPLACE INTO monitor_sent_stories (monitor_id, story_id, story_date, story_key, story_type, expires_at)
     VALUES (?, 9, 90, '9:90', 'active', 1)`,
  ).run(ORPHAN_MONITOR_ID);
  try {
    pruneOrphanedSentStories();
    expect(listSentStoryKeysAmong(live.id, ['5:50'])).toEqual(['5:50']);
    expect(listSentStoryKeysAmong(ORPHAN_MONITOR_ID, ['9:90'])).toEqual([]);
  } finally {
    removeMonitor('retention-live', '31338');
  }
});
