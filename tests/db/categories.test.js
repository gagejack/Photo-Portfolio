// tests/db/categories.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.js';
import {
  createCategory, listTree, descendantIds, ancestorIds, deleteCategory, reparentCategory, renameCategory,
  reorderCategories, ensureFavorites, getFavoritesId, CategoryChildrenLimitError,
} from '../../src/db/categories.js';

function fixture() {
  const db = openDb(':memory:');
  const urban = createCategory(db, { name: 'Urban', slug: 'urban' });
  const japan = createCategory(db, { name: 'Japan', slug: 'japan', parentId: urban, flag: 'jp' });
  const kyoto = createCategory(db, { name: 'Kyoto', slug: 'kyoto', parentId: japan });
  const nature = createCategory(db, { name: 'Nature', slug: 'nature' });
  return { db, urban, japan, kyoto, nature };
}

test('descendantIds includes self and every level below', () => {
  const { db, urban, japan, kyoto } = fixture();
  const ids = descendantIds(db, urban).sort();
  assert.deepEqual(ids, [urban, japan, kyoto].sort());
  db.close();
});

test('descendantIds on a leaf returns just itself', () => {
  const { db, kyoto } = fixture();
  assert.deepEqual(descendantIds(db, kyoto), [kyoto]);
  db.close();
});

test('ancestorIds includes the category and each parent up to the root', () => {
  const { db, urban, japan, kyoto } = fixture();
  assert.deepEqual(ancestorIds(db, kyoto), [kyoto, japan, urban]);
  db.close();
});

test('listTree nests children under parents', () => {
  const { db } = fixture();
  const tree = listTree(db).filter(node => node.slug !== 'favorites');
  assert.equal(tree.length, 2);
  const urban = tree.find(c => c.slug === 'urban');
  assert.equal(urban.children.length, 1);
  assert.equal(urban.children[0].slug, 'japan');
  assert.equal(urban.children[0].flag, 'jp');
  assert.equal(urban.children[0].children[0].slug, 'kyoto');
  db.close();
});

test('deleting a parent removes its whole subtree', () => {
  const { db, urban } = fixture();
  deleteCategory(db, urban);
  const remaining = db.prepare('SELECT slug FROM categories').all()
    .map(r => r.slug).filter(slug => slug !== 'favorites');
  assert.deepEqual(remaining, ['nature']);
  db.close();
});

test('reparenting a category to its own descendant is rejected', () => {
  const { db, urban, kyoto } = fixture();
  assert.throws(() => reparentCategory(db, urban, kyoto), /cycle/i);
  db.close();
});

test('renameCategory updates name and leaves other fields unchanged', () => {
  const { db, japan } = fixture();
  const before = db.prepare('SELECT * FROM categories WHERE id = ?').get(japan);
  renameCategory(db, japan, 'Nippon');
  const after = db.prepare('SELECT * FROM categories WHERE id = ?').get(japan);
  assert.equal(after.name, 'Nippon');
  assert.equal(after.slug, before.slug);
  assert.equal(after.parent_id, before.parent_id);
  assert.equal(after.flag, before.flag);
  db.close();
});

test('createCategory auto-increments position for siblings, resets for different parent', () => {
  const db = openDb(':memory:');
  const parent1 = createCategory(db, { name: 'Parent1', slug: 'parent1' });
  const child1a = createCategory(db, { name: 'Child1a', slug: 'child1a', parentId: parent1 });
  const child1b = createCategory(db, { name: 'Child1b', slug: 'child1b', parentId: parent1 });
  const parent2 = createCategory(db, { name: 'Parent2', slug: 'parent2' });
  const child2a = createCategory(db, { name: 'Child2a', slug: 'child2a', parentId: parent2 });

  const c1a = db.prepare('SELECT position FROM categories WHERE id = ?').get(child1a).position;
  const c1b = db.prepare('SELECT position FROM categories WHERE id = ?').get(child1b).position;
  const c2a = db.prepare('SELECT position FROM categories WHERE id = ?').get(child2a).position;

  assert.equal(c1a, 0);
  assert.equal(c1b, 1);
  assert.equal(c2a, 0);
  db.close();
});

test('a category cannot have more than three direct children', () => {
  const db = openDb(':memory:');
  const parent = createCategory(db, { name: 'Parent', slug: 'parent' });
  for (const suffix of ['a', 'b', 'c']) {
    createCategory(db, { name: suffix, slug: suffix, parentId: parent });
  }

  assert.throws(
    () => createCategory(db, { name: 'd', slug: 'd', parentId: parent }),
    CategoryChildrenLimitError,
  );
  db.close();
});

test('favorites is seeded once and sorts above user categories', () => {
  const db = openDb(':memory:');
  const favoritesId = getFavoritesId(db);
  assert.ok(favoritesId, 'favorites should exist on a fresh database');

  // ensureFavorites runs on every open; it must never create a second one.
  ensureFavorites(db);
  ensureFavorites(db);
  const roots = listTree(db).filter(node => node.slug === 'favorites');
  assert.equal(roots.length, 1);

  createCategory(db, { name: 'Urban', slug: 'urban' });
  assert.equal(listTree(db)[0].slug, 'favorites');
  db.close();
});

test('reordering siblings rewrites their positions', () => {
  const db = openDb(':memory:');
  const a = createCategory(db, { name: 'Alpha', slug: 'alpha' });
  const b = createCategory(db, { name: 'Beta', slug: 'beta' });
  const c = createCategory(db, { name: 'Gamma', slug: 'gamma' });
  const favorites = getFavoritesId(db);

  reorderCategories(db, null, [c, favorites, a, b]);
  assert.deepEqual(listTree(db).map(node => node.id), [c, favorites, a, b]);
  db.close();
});

test('reordering rejects a list that is not exactly the sibling set', () => {
  const db = openDb(':memory:');
  const parent = createCategory(db, { name: 'Travel', slug: 'travel' });
  const child = createCategory(db, { name: 'Japan', slug: 'japan', parentId: parent });
  const favorites = getFavoritesId(db);

  // Missing a sibling, duplicated ids, and a foreign child all must fail so a
  // reorder can never silently drop or reparent a category.
  assert.throws(() => reorderCategories(db, null, [parent]), /exactly once/);
  assert.throws(() => reorderCategories(db, null, [parent, parent]), /exactly once/);
  assert.throws(() => reorderCategories(db, null, [parent, favorites, child]), /exactly once/);
  assert.deepEqual(listTree(db).map(node => node.id), [favorites, parent]);
  db.close();
});
