import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { DB_PATH, DATA_DIR } from '../db';

// Place backups inside the main data directory so all runtime files
// are grouped together under a single folder.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_DAYS = 7;

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function timestamp(): string {
  const iso = new Date().toISOString();
  return iso.replace(/[:]/g, '-').split('.')[0];
}

function cleanupOldBackups() {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('database-') && f.endsWith('.db'))
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const keep = KEEP_DAYS * 2; // two backups per day
  for (let i = keep; i < files.length; i += 1) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, files[i].name));
    } catch {}
  }
}

function createBackup() {
  ensureDir();
  const dest = path.join(BACKUP_DIR, `database-${timestamp()}.db`);
  fs.copyFileSync(DB_PATH, dest);
  cleanupOldBackups();
  console.log(`[Backup] Database backed up to ${dest}`);
}

export function scheduleDatabaseBackups(): void {
  ensureDir();
  cron.schedule('0 0,12 * * *', () => {
    try {
      createBackup();
    } catch (err) {
      console.error('[Backup] Failed to create backup', err);
    }
  });
}
