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
