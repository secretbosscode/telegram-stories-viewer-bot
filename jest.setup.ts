import fs from 'fs';
import path from 'path';

// Each jest worker gets its own data directory so parallel suites do not share
// a SQLite file. CI runs in band (one worker); locally this keeps the suite
// both fast and deterministic.
const workerId = process.env.JEST_WORKER_ID || '1';
const dir = path.join('/data', `jest-worker-${workerId}`);
fs.mkdirSync(dir, { recursive: true });
process.env.TEST_DATA_DIR = dir;
