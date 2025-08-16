import fs from 'fs';
import path from 'path';

describe('locales', () => {
  const dir = path.join(__dirname, '..', 'src', 'locales');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const requiredKeys = [
    'cmd.archive',
    'cmd.globalstories',
    'stories.fetchingArchive',
    'stories.fetchingGlobal',
    'archive.downloading',
    'archive.uploading',
    'archive.none',
    'archive.uploadedBatch',
    'archive.error',
    'global.downloading',
    'global.uploading',
    'global.none',
    'global.uploadedBatch',
    'global.error',
  ];

  for (const file of files) {
    test(`${file} contains new localization keys`, () => {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const key of requiredKeys) {
        expect(Object.prototype.hasOwnProperty.call(data, key)).toBe(true);
      }
    });
  }
});
