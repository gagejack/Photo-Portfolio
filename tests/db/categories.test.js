// tests/db/categories.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.js';
import {
  createCategory, listTree, descendantIds, deleteCategory, reparentCategory
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

test('listTree nests children under parents', () => {
  const { db } = fixture();
  const tree = listTree(db);
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
  const remaining = db.prepare('SELECT slug FROM categories').all().map(r => r.slug);
  assert.deepEqual(remaining, ['nature']);
  db.close();
});

test('reparenting a category to its own descendant is rejected', () => {
  const { db, urban, kyoto } = fixture();
  assert.throws(() => reparentCategory(db, urban, kyoto), /cycle/i);
  db.close();
});
