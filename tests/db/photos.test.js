import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.js';
import { createCategory } from '../../src/db/categories.js';
import {
  insertPhoto, listPhotos, setPhotoCategories, updatePhoto, deletePhoto, getPhoto
} from '../../src/db/photos.js';

function seed() {
  const db = openDb(':memory:');
  const urban = createCategory(db, { name: 'Urban', slug: 'urban' });
  const japan = createCategory(db, { name: 'Japan', slug: 'japan', parentId: urban });
  const kyoto = createCategory(db, { name: 'Kyoto', slug: 'kyoto', parentId: japan });
  const nature = createCategory(db, { name: 'Nature', slug: 'nature' });

  const old = insertPhoto(db, { filename: 'old.jpg', takenAt: '2023-04-01T10:00:00Z', dateSource: 'exif', width: 4000, height: 3000 });
  const mid = insertPhoto(db, { filename: 'mid.jpg', takenAt: '2024-06-01T10:00:00Z', dateSource: 'exif', width: 3000, height: 4000 });
  const recent = insertPhoto(db, { filename: 'new.jpg', takenAt: '2025-10-01T10:00:00Z', dateSource: 'exif', width: 4000, height: 2250 });

  setPhotoCategories(db, recent, [kyoto]);
  setPhotoCategories(db, mid, [nature]);
  setPhotoCategories(db, old, [urban]);
  return { db, urban, japan, kyoto, nature, old, mid, recent };
}

test('listPhotos returns newest first', () => {
  const { db } = seed();
  const names = listPhotos(db, {}).map(p => p.filename);
  assert.deepEqual(names, ['new.jpg', 'mid.jpg', 'old.jpg']);
  db.close();
});

test('filtering by a parent includes photos tagged only to descendants', () => {
  const { db, urban } = seed();
  const names = listPhotos(db, { categoryId: urban }).map(p => p.filename);
  // new.jpg is tagged Kyoto only; old.jpg is tagged Urban directly
  assert.deepEqual(names, ['new.jpg', 'old.jpg']);
  db.close();
});

test('filtering by a leaf returns only its own photos', () => {
  const { db, kyoto } = seed();
  const names = listPhotos(db, { categoryId: kyoto }).map(p => p.filename);
  assert.deepEqual(names, ['new.jpg']);
  db.close();
});

test('a photo may belong to several categories', () => {
  const { db, kyoto, nature, recent } = seed();
  setPhotoCategories(db, recent, [kyoto, nature]);
  assert.equal(listPhotos(db, { categoryId: nature }).length, 2);
  assert.equal(listPhotos(db, { categoryId: kyoto }).length, 1);
  db.close();
});

test('setPhotoCategories replaces rather than appends', () => {
  const { db, kyoto, nature, recent } = seed();
  setPhotoCategories(db, recent, [nature]);
  assert.equal(listPhotos(db, { categoryId: kyoto }).length, 0);
  db.close();
});

test('editing takenAt marks the date as manual and reorders', () => {
  const { db, old } = seed();
  updatePhoto(db, old, { takenAt: '2026-01-01T00:00:00Z' });
  assert.equal(getPhoto(db, old).dateSource, 'manual');
  assert.equal(listPhotos(db, {})[0].filename, 'old.jpg');
  db.close();
});

test('deletePhoto removes the row', () => {
  const { db, recent } = seed();
  deletePhoto(db, recent);
  assert.equal(getPhoto(db, recent), undefined);
  db.close();
});
