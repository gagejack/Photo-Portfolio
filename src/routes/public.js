import express from 'express';
import { listPhotos, setPhotoDominantColor } from '../db/photos.js';
import { listTree } from '../db/categories.js';
import { photoPaths } from '../images/pipeline.js';
import { dominantColor, compareDominantColors } from '../images/color.js';

function flatten(tree, output = []) {
  for (const node of tree) {
    output.push(node);
    flatten(node.children, output);
  }
  return output;
}

async function backfillDominantColors(db, photos, photosRoot) {
  const pending = photos.filter(photo => !photo.dominantColor);
  let next = 0;

  async function worker() {
    while (next < pending.length) {
      const photo = pending[next];
      next += 1;
      try {
        const color = await dominantColor(photoPaths(photosRoot, photo.filename).thumb);
        setPhotoDominantColor(db, photo.id, color);
        photo.dominantColor = color;
      } catch (error) {
        console.warn('[color-sort] unable to analyze photo', { filename: photo.filename, error: error.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
}

export function publicRouter({ db, config }) {
  const router = express.Router();

  router.get('/api/feed', async (req, res) => {
    const categories = listTree(db);
    const slug = typeof req.query.category === 'string' ? req.query.category : null;
    const active = slug ? flatten(categories).find(category => category.slug === slug) : null;
    if (slug && !active) return res.status(404).json({ error: 'Category not found' });

    const photos = listPhotos(db, active ? { categoryId: active.id } : {});
    const colorSorted = req.query.sort === 'color';
    if (colorSorted) {
      await backfillDominantColors(db, photos, config.photosRoot);
      photos.sort((first, second) =>
        compareDominantColors(first.dominantColor, second.dominantColor));
    }

    return res.json({
      photos,
      categories,
      activeSlug: active?.slug ?? null,
      sort: colorSorted ? 'color' : null,
    });
  });

  return router;
}
