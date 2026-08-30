// tests/images/exif.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { extractDate } from '../../src/images/exif.js';

async function plainJpeg() {
  return sharp({ create: { width: 10, height: 10, channels: 3, background: '#888' } })
    .jpeg().toBuffer();
}

test('falls back to mtime when EXIF has no date', async () => {
  const buf = await plainJpeg();
  const mtime = new Date('2024-03-05T12:00:00Z');
  const r = await extractDate(buf, mtime);
  assert.equal(r.source, 'mtime');
  assert.equal(r.takenAt, '2024-03-05T12:00:00.000Z');
});

test('reads DateTimeOriginal when present', async () => {
  const withExif = await sharp({
    create: { width: 10, height: 10, channels: 3, background: '#888' },
  })
    .withExif({ IFD0: { DateTimeOriginal: '2025:07:14 09:30:00' } })
    .jpeg()
    .toBuffer();

  const r = await extractDate(withExif, new Date('2000-01-01T00:00:00Z'));
  assert.equal(r.source, 'exif');
  assert.ok(r.takenAt.startsWith('2025-07-14'));
});

test('falls back to mtime on an unparseable buffer', async () => {
  const mtime = new Date('2022-11-11T00:00:00Z');
  const r = await extractDate(Buffer.from('not an image'), mtime);
  assert.equal(r.source, 'mtime');
  assert.equal(r.takenAt, '2022-11-11T00:00:00.000Z');
});
