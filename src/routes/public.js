import express from 'express';
import { listPhotos } from '../db/photos.js';
import { listTree } from '../db/categories.js';

function flatten(tree, output = []) {
  for (const node of tree) {
    output.push(node);
    flatten(node.children, output);
  }
  return output;
}

export function publicRouter(db) {
  const router = express.Router();

  router.get('/api/feed', (req, res) => {
    const categories = listTree(db);
    const slug = typeof req.query.category === 'string' ? req.query.category : null;
    const active = slug ? flatten(categories).find(category => category.slug === slug) : null;
    if (slug && !active) return res.status(404).json({ error: 'Category not found' });

    return res.json({
      photos: listPhotos(db, active ? { categoryId: active.id } : {}),
      categories,
      activeSlug: active?.slug ?? null,
    });
  });

  return router;
}
