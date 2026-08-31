import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { processUpload, hashName, photoPaths, removePhotoFiles, assertIsImage, stagingDir, sweepStaging } from '../../src/images/pipeline.js';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'pp-'));
}
async function jpeg(w = 2400, h = 1600) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#4a7' } })
    .jpeg().toBuffer();
}
async function orientedJpeg(orientation, w = 800, h = 400) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#4a7' } })
    .withMetadata({ orientation })
    .jpeg()
    .toBuffer();
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
  assert.equal((await sharp(p.display).metadata()).width, 2400); // under the 2560 cap, not upscaled
  assert.equal((await sharp(p.original).metadata()).width, 2400);
  rmSync(root, { recursive: true, force: true });
});

test('records post-rotation dimensions for every EXIF orientation', async () => {
  // Orientations 5-8 transpose the image; 1-4 do not. The recorded width and
  // height must describe the image as a viewer sees it, after rotation.
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const root = tmpRoot();
    const transposed = orientation >= 5;
    const r = await processUpload({
      buffer: await orientedJpeg(orientation, 800, 400),
      mtime: new Date(),
      photosRoot: root,
    });
    assert.equal(r.width, transposed ? 400 : 800, `width for orientation ${orientation}`);
    assert.equal(r.height, transposed ? 800 : 400, `height for orientation ${orientation}`);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the display variant is capped at 2560px', async () => {
  const root = tmpRoot();
  const r = await processUpload({ buffer: await jpeg(6000, 4000), mtime: new Date(), photosRoot: root });
  const p = photoPaths(root, r.filename);
  assert.equal((await sharp(p.display).metadata()).width, 2560);
  assert.equal((await sharp(p.thumb).metadata()).width, 400);
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

test('a derivative failure mid-pipeline cleans up every file already written', async () => {
  const root = tmpRoot();
  const full = await jpeg(800, 600);
  // Truncate one byte off a real, well-formed JPEG. The truncated buffer
  // still has a valid header, so it passes `assertIsImage` and the initial
  // `sharp(buffer).metadata()` validation call — but decoding pixels (which
  // `.rotate().toBuffer()` must do to apply EXIF orientation and produce
  // the derivatives) hits "premature end of JPEG image" and throws. This
  // drives execution into the catch block in `processUpload`, proving the
  // cleanup path actually removes a partially-written photo rather than
  // just proving pre-write validation (which the "corrupt buffer" test
  // above already covers).
  const truncated = full.subarray(0, full.length - 1);

  await assert.rejects(
    () => processUpload({ buffer: truncated, mtime: new Date(), photosRoot: root })
  );

  const filename = `${hashName(truncated)}.jpg`;
  const p = photoPaths(root, filename);
  assert.ok(!existsSync(p.original), 'original must not survive a failed upload');
  assert.ok(!existsSync(p.display), 'display must not survive a failed upload');
  assert.ok(!existsSync(p.thumb), 'thumb must not survive a failed upload');
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

test('sweepStaging empties the staging directory', async () => {
  const root = tmpRoot();
  const dir = stagingDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'abandoned-1'), 'bytes');
  writeFileSync(join(dir, 'abandoned-2'), 'bytes');

  assert.equal(sweepStaging(root), 2);
  assert.equal(existsSync(join(dir, 'abandoned-1')), false);
  assert.ok(existsSync(dir), 'the directory itself survives');
  rmSync(root, { recursive: true, force: true });
});

test('sweepStaging on a missing directory is a no-op', () => {
  const root = tmpRoot();
  assert.equal(sweepStaging(root), 0);
  rmSync(root, { recursive: true, force: true });
});

test('sweepStaging removes a directory left inside staging', () => {
  const root = tmpRoot();
  const dir = stagingDir(root);
  mkdirSync(join(dir, 'leftover-dir'), { recursive: true });
  writeFileSync(join(dir, 'plain-file'), 'bytes');

  assert.equal(sweepStaging(root), 2);
  assert.equal(existsSync(join(dir, 'leftover-dir')), false);
  assert.equal(existsSync(join(dir, 'plain-file')), false);
  assert.ok(existsSync(dir), 'the staging directory itself survives');
  rmSync(root, { recursive: true, force: true });
});
