import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { processUpload, hashName, photoPaths, removePhotoFiles, assertIsImage } from '../../src/images/pipeline.js';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'pp-'));
}
async function jpeg(w = 2400, h = 1600) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#4a7' } })
    .jpeg().toBuffer();
}

test('processUpload writes original, display, and thumb', async () => {
  const root = tmpRoot();
  const buf = await jpeg();
  const r = await processUpload({ buffer: buf, mtime: new Date('2025-01-02T03:04:05Z'), photosRoot: root });

  const p = photoPaths(root, r.filename);
  assert.ok(existsSync(p.original));
  assert.ok(existsSync(p.display));
  assert.ok(existsSync(p.thumb));
  rmSync(root, { recursive: true, force: true });
});

test('records the original dimensions', async () => {
  const root = tmpRoot();
  const r = await processUpload({ buffer: await jpeg(2400, 1600), mtime: new Date(), photosRoot: root });
  assert.equal(r.width, 2400);
  assert.equal(r.height, 1600);
  rmSync(root, { recursive: true, force: true });
});

test('derivatives are resized and the original is untouched', async () => {
  const root = tmpRoot();
  const buf = await jpeg(2400, 1600);
  const r = await processUpload({ buffer: buf, mtime: new Date(), photosRoot: root });
  const p = photoPaths(root, r.filename);

  assert.equal((await sharp(p.thumb).metadata()).width, 400);
  assert.equal((await sharp(p.display).metadata()).width, 1600);
  assert.equal((await sharp(p.original).metadata()).width, 2400);
  rmSync(root, { recursive: true, force: true });
});

test('an image smaller than a target is not upscaled', async () => {
  const root = tmpRoot();
  const r = await processUpload({ buffer: await jpeg(300, 200), mtime: new Date(), photosRoot: root });
  const p = photoPaths(root, r.filename);
  assert.equal((await sharp(p.display).metadata()).width, 300);
  rmSync(root, { recursive: true, force: true });
});

test('the same bytes always produce the same filename', async () => {
  const buf = await jpeg();
  assert.equal(hashName(buf), hashName(Buffer.from(buf)));
});

test('a corrupt buffer throws and leaves no files behind', async () => {
  const root = tmpRoot();
  await assert.rejects(
    () => processUpload({ buffer: Buffer.from('garbage'), mtime: new Date(), photosRoot: root })
  );
  const leftover = existsSync(join(root, 'originals'))
    ? (await import('node:fs')).readdirSync(join(root, 'originals'))
    : [];
  assert.equal(leftover.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test('removePhotoFiles deletes all three variants', async () => {
  const root = tmpRoot();
  const r = await processUpload({ buffer: await jpeg(), mtime: new Date(), photosRoot: root });
  removePhotoFiles(root, r.filename);
  const p = photoPaths(root, r.filename);
  assert.ok(!existsSync(p.original));
  assert.ok(!existsSync(p.display));
  assert.ok(!existsSync(p.thumb));
  rmSync(root, { recursive: true, force: true });
});

test('assertIsImage accepts a real JPEG', async () => {
  assertIsImage(await jpeg(10, 10));
});

test('assertIsImage rejects a PDF masquerading as .jpg', () => {
  const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n');
  assert.throws(() => assertIsImage(pdf), /Unsupported file type/);
});

test('assertIsImage rejects a text file', () => {
  assert.throws(() => assertIsImage(Buffer.from('hello world')), /Unsupported file type/);
});
