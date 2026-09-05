import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { db } from '../src/db';
import {
  archiveProfilePhotos,
  listArchivedPhotos,
  MAX_ARCHIVED_PHOTOS_PER_TARGET,
  MAX_ARCHIVE_DOWNLOADS_PER_CYCLE,
  PROFILE_ARCHIVE_DIR,
} from '../src/services/profile-photo-archive';

const TARGET = '777002';

afterAll(() => {
  db.prepare('DELETE FROM monitor_profile_photos WHERE target_id = ?').run(TARGET);
  fs.rmSync(path.join(PROFILE_ARCHIVE_DIR, TARGET), { recursive: true, force: true });
});

test('the per-target file cap rotates out still-visible photos instead of stopping', async () => {
  db.prepare('DELETE FROM monitor_profile_photos WHERE target_id = ?').run(TARGET);
  const client = {
    downloadMedia: jest.fn(async () => Buffer.from('x')),
  };
  // Fill the cap in cycles of MAX_ARCHIVE_DOWNLOADS_PER_CYCLE. Photo ids
  // descend so that the newest photo is first, as Telegram returns them.
  const ids = Array.from({ length: MAX_ARCHIVED_PHOTOS_PER_TARGET }, (_, i) => 1000 - i);
  const photos = () => ids.map((id) => ({ id, videoSizes: [] }));
  for (let i = 0; i < MAX_ARCHIVED_PHOTOS_PER_TARGET / MAX_ARCHIVE_DOWNLOADS_PER_CYCLE; i += 1) {
    await archiveProfilePhotos(client, TARGET, photos(), false);
  }
  const files = () => listArchivedPhotos(TARGET).filter((p) => p.file_path);
  expect(files()).toHaveLength(MAX_ARCHIVED_PHOTOS_PER_TARGET);

  // A brand-new avatar arrives while the cap is full: it must be archived, and
  // the oldest still-visible photo gives up its file.
  ids.unshift(2000);
  await archiveProfilePhotos(client, TARGET, photos(), false);
  const after = files();
  expect(after).toHaveLength(MAX_ARCHIVED_PHOTOS_PER_TARGET);
  expect(after.some((p) => p.photo_id === '2000')).toBe(true);
  const evicted = listArchivedPhotos(TARGET).find((p) => p.photo_id === '901');
  expect(evicted?.file_path).toBeNull();
});
