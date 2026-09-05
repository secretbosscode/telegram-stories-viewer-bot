import fs from 'fs';
import path from 'path';
import { db, DATA_DIR } from 'db';

/**
 * Profile-photo archive.
 *
 * Telegram keeps a user's previous avatars in their photo history until the
 * user deletes them, and a deleted photo leaves the API for good. Monitoring
 * used to ask for the single latest photo once an hour, so anything posted and
 * removed within the hour was never seen, and anything deleted from history
 * was lost even when the bot had seen it earlier.
 *
 * Every time a target's photo history is fetched, this module records each
 * photo id and stores the file the first time it is seen. When a previously
 * seen photo is missing from a complete history read, it is marked deleted and
 * the archived copy can be shown to subscribers. Nothing here widens access:
 * only photos the userbot could already see are ever stored.
 *
 * Files live under /data/profile-archive/<target_id>/ and are bounded per
 * target and per cycle so a target with a long history cannot stall a cycle
 * or fill the disk. Archives for targets nobody monitors any more are purged
 * after a grace period.
 */

// Some unit tests stub the db module without DATA_DIR; fall back to the
// production location rather than failing at import time.
export const PROFILE_ARCHIVE_DIR = path.join(
  typeof DATA_DIR === 'string' && DATA_DIR ? DATA_DIR : '/data',
  'profile-archive',
);
export const MAX_ARCHIVED_PHOTOS_PER_TARGET = 100;
export const MAX_ARCHIVE_DOWNLOADS_PER_CYCLE = 10;
const ORPHAN_ARCHIVE_TTL_SECONDS = 30 * 24 * 60 * 60;

db.exec(`
  CREATE TABLE IF NOT EXISTS monitor_profile_photos (
    target_id TEXT NOT NULL,
    photo_id TEXT NOT NULL,
    is_video INTEGER NOT NULL DEFAULT 0,
    photo_date INTEGER,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    deleted_at INTEGER,
    file_path TEXT,
    PRIMARY KEY (target_id, photo_id)
  );
  CREATE INDEX IF NOT EXISTS monitor_profile_photos_target_idx
    ON monitor_profile_photos (target_id, deleted_at, last_seen);
`);

export interface ArchivedPhoto {
  target_id: string;
  photo_id: string;
  is_video: number;
  photo_date: number | null;
  first_seen: number;
  last_seen: number;
  deleted_at: number | null;
  file_path: string | null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isVideoPhoto(photo: any): boolean {
  return Array.isArray(photo?.videoSizes) && photo.videoSizes.length > 0;
}

/**
 * Downloads a profile photo, choosing the size explicitly. With no thumb
 * argument, downloadMedia merges static and video sizes and returns whichever
 * is largest, so a video-flagged avatar could come back as a JPEG.
 */
export async function downloadProfilePhoto(
  client: any,
  photo: any,
): Promise<{ buffer: Buffer; isVideo: boolean }> {
  const isVideo = isVideoPhoto(photo);
  const videoSizes: any[] = isVideo ? photo.videoSizes : [];
  const buffer = (await client.downloadMedia(photo, {
    thumb: isVideo ? videoSizes[videoSizes.length - 1] : undefined,
  })) as Buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Empty profile media download');
  }
  return { buffer, isVideo };
}

export function listArchivedPhotos(targetId: string): ArchivedPhoto[] {
  return db
    .prepare(
      `SELECT * FROM monitor_profile_photos WHERE target_id = ? ORDER BY first_seen DESC`,
    )
    .all(targetId) as ArchivedPhoto[];
}

/** Deleted photos for which an archived file exists, newest deletion first. */
export function listDeletedArchivedPhotos(targetId: string, limit = 10): ArchivedPhoto[] {
  const rows = db
    .prepare(
      `SELECT * FROM monitor_profile_photos
       WHERE target_id = ? AND deleted_at IS NOT NULL AND file_path IS NOT NULL
       ORDER BY deleted_at DESC
       LIMIT ?`,
    )
    .all(targetId, limit) as ArchivedPhoto[];
  return rows.filter((row) => row.file_path && fs.existsSync(row.file_path));
}

/**
 * Records a freshly fetched photo history for a target, stores files that are
 * not archived yet, and reports photos that have disappeared.
 *
 * @param photos   The photo history as returned by photos.GetUserPhotos,
 *                 newest first.
 * @param complete Whether `photos` is the entire history. Disappearance is
 *                 only judged on a complete, non-empty read: a partial page
 *                 says nothing about older photos, and an empty result is also
 *                 what a privacy change, a block or a deleted account returns.
 */
export async function archiveProfilePhotos(
  client: any,
  targetId: string,
  photos: any[],
  complete: boolean,
): Promise<{ archived: number; deleted: ArchivedPhoto[] }> {
  const now = nowSeconds();
  const valid = (photos || []).filter(
    (photo) => photo && photo.id !== undefined && photo.id !== null,
  );

  const upsert = db.prepare(
    `INSERT INTO monitor_profile_photos (
       target_id, photo_id, is_video, photo_date, first_seen, last_seen, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(target_id, photo_id) DO UPDATE SET
       last_seen = excluded.last_seen,
       is_video = excluded.is_video,
       deleted_at = NULL`,
  );
  for (const photo of valid) {
    upsert.run(
      targetId,
      String(photo.id),
      isVideoPhoto(photo) ? 1 : 0,
      typeof photo.date === 'number' ? photo.date : null,
      now,
      now,
    );
  }

  const known = new Map(listArchivedPhotos(targetId).map((row) => [row.photo_id, row]));
  let filesOnDisk = [...known.values()].filter((row) => row.file_path).length;
  let archived = 0;
  for (const photo of valid) {
    if (
      archived >= MAX_ARCHIVE_DOWNLOADS_PER_CYCLE ||
      filesOnDisk >= MAX_ARCHIVED_PHOTOS_PER_TARGET
    ) {
      break;
    }
    const photoId = String(photo.id);
    if (known.get(photoId)?.file_path) continue;
    try {
      const { buffer, isVideo } = await downloadProfilePhoto(client, photo);
      const dir = path.join(PROFILE_ARCHIVE_DIR, targetId);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${photoId}.${isVideo ? 'mp4' : 'jpg'}`);
      fs.writeFileSync(filePath, buffer);
      db.prepare(
        `UPDATE monitor_profile_photos SET file_path = ?, is_video = ?
         WHERE target_id = ? AND photo_id = ?`,
      ).run(filePath, isVideo ? 1 : 0, targetId, photoId);
      archived += 1;
      filesOnDisk += 1;
    } catch (error) {
      console.error(`[PhotoArchive] Could not archive photo ${photoId} of ${targetId}:`, error);
    }
  }

  if (!complete || valid.length === 0) return { archived, deleted: [] };

  const presentIds = new Set(valid.map((photo) => String(photo.id)));
  const missing = [...known.values()].filter(
    (row) => !row.deleted_at && !presentIds.has(row.photo_id),
  );
  const markDeleted = db.prepare(
    `UPDATE monitor_profile_photos SET deleted_at = ? WHERE target_id = ? AND photo_id = ?`,
  );
  for (const row of missing) markDeleted.run(now, targetId, row.photo_id);
  return { archived, deleted: missing.map((row) => ({ ...row, deleted_at: now })) };
}

/**
 * Removes archives for targets that no monitor references any more, once
 * they have gone unseen for the grace period. Returns the number of targets
 * purged.
 */
export function purgeOrphanedPhotoArchives(): number {
  const cutoff = nowSeconds() - ORPHAN_ARCHIVE_TTL_SECONDS;
  const targets = db
    .prepare(
      `SELECT target_id, MAX(last_seen) AS last_seen
       FROM monitor_profile_photos
       WHERE target_id NOT IN (SELECT target_id FROM monitors)
       GROUP BY target_id
       HAVING MAX(last_seen) < ?`,
    )
    .all(cutoff) as { target_id: string }[];
  for (const { target_id } of targets) {
    try {
      fs.rmSync(path.join(PROFILE_ARCHIVE_DIR, target_id), { recursive: true, force: true });
    } catch (error) {
      console.error(`[PhotoArchive] Could not remove archive directory for ${target_id}:`, error);
    }
    db.prepare('DELETE FROM monitor_profile_photos WHERE target_id = ?').run(target_id);
  }
  return targets.length;
}
