// src/images/pipeline.js
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractDate } from './exif.js';
import { dominantColor as extractDominantColor } from './color.js';

const THUMB_WIDTH = 800;
const DISPLAY_WIDTH = 2560;

// sharp defaults to `effort: 4`. On a 2560px encode that costs roughly 600ms
// per photo and buys about 2KB of file size versus `effort: 2` — measured, see
// the design doc. Encoding, not decoding, dominates this pipeline.
const WEBP_EFFORT = 2;

// EXIF orientations 5-8 transpose the image; 1-4 leave the axes alone.
const TRANSPOSING_ORIENTATIONS = new Set([5, 6, 7, 8]);

// Magic-number sniffing. The spec requires content-based validation
// because a file extension is attacker-controlled.
const SIGNATURES = [
  { name: 'jpeg', bytes: [0xff, 0xd8, 0xff], offset: 0 },
  { name: 'png',  bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 },
  { name: 'webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  { name: 'heic', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
];

export function assertIsImage(buffer) {
  const ok = SIGNATURES.some(sig =>
    sig.bytes.every((b, i) => buffer[sig.offset + i] === b)
  );
  if (!ok) throw new Error('Unsupported file type');
}

export function hashName(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

export function photoPaths(photosRoot, filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  return {
    original: join(photosRoot, 'originals', filename),
    display: join(photosRoot, 'display', `${base}.webp`),
    thumb: join(photosRoot, 'thumb', `${base}.webp`),
  };
}

export function stagingDir(photosRoot) {
  return join(photosRoot, 'staging');
}

// Staged bytes are only meaningful to the in-memory queue that referenced them.
// After a restart that queue is gone, so anything still here is orphaned.
export function sweepStaging(photosRoot) {
  const dir = stagingDir(photosRoot);
  if (!existsSync(dir)) return 0;
  const names = readdirSync(dir);
  for (const name of names) rmSync(join(dir, name), { recursive: true, force: true });
  return names.length;
}

export function removePhotoFiles(photosRoot, filename) {
  const p = photoPaths(photosRoot, filename);
  for (const f of [p.original, p.display, p.thumb]) {
    rmSync(f, { force: true });
  }
}

export async function processUpload({ buffer, mtime, photosRoot }) {
  assertIsImage(buffer);

  // Validate and read dimensions before writing anything to disk.
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error('Unreadable image');

  const ext = meta.format === 'png' ? 'png' : 'jpg';
  const filename = `${hashName(buffer)}.${ext}`;
  const paths = photoPaths(photosRoot, filename);

  for (const dir of ['originals', 'display', 'thumb']) {
    mkdirSync(join(photosRoot, dir), { recursive: true });
  }

  let rotatedWidth;
  let rotatedHeight;
  let color;

  try {
    // `.metadata()` on a `rotate()`-chained pipeline does NOT report swapped
    // width/height — it only surfaces the orientation tag. Rather than paying
    // for a full-size rotate pass just to measure the result (~380ms on a 21MB
    // file, all of it discarded), read the tag off the unchained input and
    // apply the swap ourselves.
    const transposed = TRANSPOSING_ORIENTATIONS.has(meta.orientation);
    rotatedWidth = transposed ? meta.height : meta.width;
    rotatedHeight = transposed ? meta.width : meta.height;

    // Decode once. The thumb is derived from the already-decoded display
    // buffer rather than decoding the original a second time; at 2560 to 400
    // the extra resampling step is not visible.
    const display = await sharp(buffer)
      .rotate()
      .resize({ width: DISPLAY_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82, effort: WEBP_EFFORT })
      .toBuffer();
    const thumb = await sharp(display)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78, effort: WEBP_EFFORT })
      .toBuffer();
    color = await extractDominantColor(thumb);

    await writeFile(paths.original, buffer);
    await writeFile(paths.display, display);
    await writeFile(paths.thumb, thumb);
  } catch (err) {
    removePhotoFiles(photosRoot, filename);
    throw err;
  }

  const { takenAt, source } = await extractDate(buffer, mtime);

  return {
    filename,
    takenAt,
    dateSource: source,
    width: rotatedWidth,
    height: rotatedHeight,
    dominantColor: color,
  };
}
