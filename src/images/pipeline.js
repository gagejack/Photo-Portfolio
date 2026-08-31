// src/images/pipeline.js
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { extractDate } from './exif.js';

const THUMB_WIDTH = 400;
const DISPLAY_WIDTH = 1600;

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

  try {
    // `rotate()` with no argument applies EXIF orientation.
    const base = () => sharp(buffer).rotate();

    // `.metadata()` on a `rotate()`-chained pipeline does NOT apply the
    // orientation swap to the reported width/height — it only surfaces the
    // orientation tag; the swap only takes effect once pixels are actually
    // processed through the pipeline. So we run a dedicated rotate-only
    // pass (no resize) and read the true post-rotation full-size
    // dimensions off its `info` via `resolveWithObject`.
    const { info: rotatedInfo } = await base().toBuffer({ resolveWithObject: true });
    rotatedWidth = rotatedInfo.width;
    rotatedHeight = rotatedInfo.height;

    const display = await base()
      .resize({ width: DISPLAY_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const thumb = await base()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();

    writeFileSync(paths.original, buffer);
    writeFileSync(paths.display, display);
    writeFileSync(paths.thumb, thumb);
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
  };
}
