import sharp from 'sharp';
import { mkdir, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const THUMB_WIDTH = 800;
const [photosRoot] = process.argv.slice(2);

if (!photosRoot) {
  console.error('Usage: npm run rebuild-thumbnails -- /path/to/photos');
  process.exit(1);
}

const displayDir = join(photosRoot, 'display');
const thumbDir = join(photosRoot, 'thumb');
await mkdir(thumbDir, { recursive: true });

const entries = await readdir(displayDir, { withFileTypes: true });
const displays = entries.filter(entry => entry.isFile() && extname(entry.name) === '.webp');

for (const entry of displays) {
  await sharp(join(displayDir, entry.name))
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 78, effort: 2 })
    .toFile(join(thumbDir, entry.name));
}

console.log(`Rebuilt ${displays.length} thumbnail(s) at ${THUMB_WIDTH}px.`);
