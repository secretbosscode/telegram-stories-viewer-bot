import fs from 'fs';
import path from 'path';
import util from 'util';
import { DEBUG_LOG_FILE } from './env-config';

const logFile = DEBUG_LOG_FILE;
const logDir = path.dirname(logFile);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function writeLog(message: string): void {
  const entry = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, entry);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to write debug log', err);
  }
}

(['log', 'error', 'warn'] as const).forEach((method) => {
  const original = console[method].bind(console);
  console[method] = (...args: any[]) => {
    const formatted = util.format(...args);
    writeLog(formatted);
    original(...args);
  };
});
