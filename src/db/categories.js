// src/db/categories.js

export function createCategory(db, { name, slug, parentId = null, flag = null }) {
  const pos = db.prepare(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories WHERE parent_id IS ?'
  ).get(parentId).p;
  const info = db.prepare(
    'INSERT INTO categories (name, slug, parent_id, flag, position) VALUES (?,?,?,?,?)'
  ).run(name, slug, parentId, flag, pos);
  return Number(info.lastInsertRowid);
}

// Recursive CTE: walk down from the given id, collecting every descendant.
export function descendantIds(db, categoryId) {
  const rows = db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM categories WHERE id = ?
      UNION ALL
      SELECT c.id FROM categories c JOIN sub ON c.parent_id = sub.id
    )
    SELECT id FROM sub
  `).all(categoryId);
  return rows.map(r => r.id);
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

export function reparentCategory(db, id, parentId) {
  if (parentId !== null && descendantIds(db, id).includes(parentId)) {
    throw new Error('Cannot reparent a category into its own subtree: cycle');
  }
  db.prepare('UPDATE categories SET parent_id = ? WHERE id = ?').run(parentId, id);
}
