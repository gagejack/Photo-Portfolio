import { descendantIds } from './categories.js';

const SELECT_COLS = `
  id, filename, taken_at AS takenAt, date_source AS dateSource,
  width, height, caption
`;

const SELECT_P_COLS = `
  p.id, p.filename, p.taken_at AS takenAt, p.date_source AS dateSource,
  p.width, p.height, p.caption
`;

export function insertPhoto(db, { filename, takenAt, dateSource, width, height, caption = null }) {
  const info = db.prepare(`
    INSERT INTO photos (filename, taken_at, date_source, width, height, caption)
    VALUES (?,?,?,?,?,?)
  `).run(filename, takenAt, dateSource, width, height, caption);
  return Number(info.lastInsertRowid);
}

export function getPhoto(db, id) {
  return db.prepare(`SELECT ${SELECT_COLS} FROM photos WHERE id = ?`).get(id);
}

export function listPhotos(db, { categoryId = null } = {}) {
  if (categoryId === null) {
    return db.prepare(
      `SELECT ${SELECT_COLS} FROM photos ORDER BY taken_at DESC, id DESC`
    ).all();
  }
  const ids = descendantIds(db, categoryId);
  const holes = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT DISTINCT ${SELECT_P_COLS}
    FROM photos p
    JOIN photo_categories pc ON pc.photo_id = p.id
    WHERE pc.category_id IN (${holes})
    ORDER BY p.taken_at DESC, p.id DESC
  `).all(...ids);
}

export function photoCategoryIds(db, photoId) {
  return db.prepare(
    'SELECT category_id AS categoryId FROM photo_categories WHERE photo_id = ? ORDER BY category_id'
  ).all(photoId).map(row => row.categoryId);
}

export function setPhotoCategories(db, photoId, categoryIds) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM photo_categories WHERE photo_id = ?').run(photoId);
    const ins = db.prepare(
      'INSERT OR IGNORE INTO photo_categories (photo_id, category_id) VALUES (?,?)'
    );
    for (const cid of categoryIds) ins.run(photoId, cid);
  });
  tx();
}

export function updatePhoto(db, id, { caption, takenAt }) {
  if (caption !== undefined) {
    db.prepare('UPDATE photos SET caption = ? WHERE id = ?').run(caption, id);
  }
  if (takenAt !== undefined) {
    db.prepare(
      "UPDATE photos SET taken_at = ?, date_source = 'manual' WHERE id = ?"
    ).run(takenAt, id);
  }
}

export function deletePhoto(db, id) {
  db.prepare('DELETE FROM photos WHERE id = ?').run(id);
}
