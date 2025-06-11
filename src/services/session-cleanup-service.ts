import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

// Temporary session files are stored in the same data directory as the
// database to keep everything contained under a single folder.
const SESSION_PREFIX = 'userbot-session';
const KEEP_DAYS = 7;

function cleanupOldSessions(): void {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync('/data').filter((f) => f.startsWith(SESSION_PREFIX));
  for (const name of files) {
    try {
      const file = path.join('/data', name);
      const mtime = fs.statSync(file).mtime.getTime();
      if (mtime < cutoff) {
        fs.unlinkSync(file);
      }
    } catch (err) {
      console.error('[SessionCleanup] Failed to remove file', name, err);
    }
  }
}

export function scheduleSessionCleanup(): void {
  cleanupOldSessions();
  cron.schedule('30 3 * * *', () => {
    try {
      cleanupOldSessions();
    } catch (err) {
      console.error('[SessionCleanup] Error during cleanup', err);
    }
  });
}
