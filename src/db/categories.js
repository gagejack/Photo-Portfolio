// src/db/categories.js

export const MAX_CATEGORY_CHILDREN = 3;

export class CategoryChildrenLimitError extends Error {
  constructor() {
    super(`A category can have at most ${MAX_CATEGORY_CHILDREN} subcategories`);
  }
}

export function createCategory(db, { name, slug, parentId = null, flag = null }) {
  // Keep the limit alongside the write and inside a transaction. The sidebar
  // disables the action at three children too, but this makes the rule hold
  // for direct API calls and concurrent requests as well.
  const insert = db.transaction(() => {
    if (parentId !== null) {
      const parent = db.prepare('SELECT 1 FROM categories WHERE id = ?').get(parentId);
      if (!parent) throw new Error('Parent category not found');

      const childCount = db.prepare(
        'SELECT COUNT(*) AS count FROM categories WHERE parent_id = ?'
      ).get(parentId).count;
      if (childCount >= MAX_CATEGORY_CHILDREN) throw new CategoryChildrenLimitError();
    }

    const pos = db.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories WHERE parent_id IS ?'
    ).get(parentId).p;
    const info = db.prepare(
      'INSERT INTO categories (name, slug, parent_id, flag, position) VALUES (?,?,?,?,?)'
    ).run(name, slug, parentId, flag, pos);
    return Number(info.lastInsertRowid);
  });

  return insert();
}

// Recursive CTE: walk down from the given id, collecting every descendant.
export function descendantIds(db, categoryId) {
  const rows = db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM categories WHERE id = ?
      UNION
      SELECT c.id FROM categories c JOIN sub ON c.parent_id = sub.id
    )
    SELECT id FROM sub
  `).all(categoryId);
  return rows.map(r => r.id);
}

// Walk upward from a category so assigning a subcategory can also assign its
// containing categories. The selected category is included as the first row.
export function ancestorIds(db, categoryId) {
  const rows = db.prepare(`
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM categories WHERE id = ?
      UNION ALL
      SELECT c.id, c.parent_id FROM categories c JOIN ancestors a ON c.id = a.parent_id
    )
    SELECT id FROM ancestors
  `).all(categoryId);
  return rows.map(row => row.id);
}

export function listTree(db) {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.slug, c.parent_id AS parentId, c.flag, c.position,
           (SELECT COUNT(*) FROM photo_categories pc WHERE pc.category_id = c.id) AS photoCount
    FROM categories c
    ORDER BY c.position, c.name
  `).all();

  const byId = new Map(rows.map(r => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parentId === null) roots.push(node);
    // FK constraint guarantees parent_id resolves; unreachable parent silently drops the node
    else byId.get(node.parentId)?.children.push(node);
  }
  return roots;
}

export function renameCategory(db, id, name) {
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
}

export function deleteCategory(db, id) {
  // ON DELETE CASCADE on parent_id removes the subtree
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

// Favorites is seeded on every open so a fresh database and an existing one
// both end up with exactly one. Position -1 keeps it above user categories,
// which are numbered from 0 upward.
export const FAVORITES_SLUG = 'favorites';

export function ensureFavorites(db) {
  const existing = db.prepare(
    'SELECT id FROM categories WHERE slug = ? AND parent_id IS NULL'
  ).get(FAVORITES_SLUG);
  if (existing) return existing.id;
  const info = db.prepare(
    "INSERT INTO categories (name, slug, parent_id, flag, position) VALUES (?,?,NULL,NULL,-1)"
  ).run('Favorites', FAVORITES_SLUG);
  return Number(info.lastInsertRowid);
}

export function getFavoritesId(db) {
  return db.prepare(
    'SELECT id FROM categories WHERE slug = ? AND parent_id IS NULL'
  ).get(FAVORITES_SLUG)?.id ?? null;
}

// Reorder siblings by writing the given order back as positions. Every id must
// be a sibling of the same parent, so a reorder can never smuggle in a move
// between parents -- that is reparentCategory's job.
export function reorderCategories(db, parentId, orderedIds) {
  const apply = db.transaction(() => {
    const siblings = db.prepare(
      'SELECT id FROM categories WHERE parent_id IS ?'
    ).all(parentId).map(row => row.id);

    if (orderedIds.length !== siblings.length
      || orderedIds.some(id => !siblings.includes(id))
      || new Set(orderedIds).size !== orderedIds.length) {
      throw new Error('Order must list each sibling category exactly once');
    }

    const update = db.prepare('UPDATE categories SET position = ? WHERE id = ?');
    orderedIds.forEach((id, index) => update.run(index, id));
  });
  apply();
}

export function reparentCategory(db, id, parentId) {
  if (parentId !== null && descendantIds(db, id).includes(parentId)) {
    throw new Error('Cannot reparent a category into its own subtree: cycle');
  }
  db.prepare('UPDATE categories SET parent_id = ? WHERE id = ?').run(parentId, id);
}
