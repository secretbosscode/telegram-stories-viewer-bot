import fs from 'fs';
import path from 'path';
import util from 'util';
import { DEBUG_LOG, DEBUG_LOG_FILE } from './env-config';

// Only mirror logs to a file when DEBUG_LOG is enabled
if (DEBUG_LOG) {
  const logFile = DEBUG_LOG_FILE;
  const logDir = path.dirname(logFile);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  function rotateLogs() {
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      const dateStr = stats.mtime.toISOString().slice(0, 10);
      const rotated = path.join(logDir, `debug-${dateStr}.log`);
      if (!fs.existsSync(rotated)) {
        fs.renameSync(logFile, rotated);
      }
    }
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(logDir)) {
      if (/^debug-\d{4}-\d{2}-\d{2}\.log$/.test(name)) {
        const file = path.join(logDir, name);
        try {
          if (fs.statSync(file).mtime.getTime() < cutoff) {
            fs.unlinkSync(file);
          }
        } catch {}
      }
    }
  }

  rotateLogs();

  const originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
  } as const;

  function writeLog(message: string): void {
    const entry = `[${new Date().toISOString()}] ${message}\n`;
    try {
      fs.appendFileSync(logFile, entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      originalConsole.error('Failed to write debug log', err);
    }
  }

  (['log', 'error', 'warn'] as const).forEach((method) => {
    const original = originalConsole[method];
    console[method] = (...args: any[]) => {
      const formatted = util.format(...args);
      writeLog(formatted);
      original(...args);
    };
  });
}
