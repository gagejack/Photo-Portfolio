import Database from 'better-sqlite3';
import { ensureFavorites } from './categories.js';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function ensurePhotoColorColumn(db) {
  const columns = db.pragma('table_info(photos)').map(column => column.name);
  if (!columns.includes('dominant_color')) {
    db.exec('ALTER TABLE photos ADD COLUMN dominant_color TEXT');
  }
}

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  ensurePhotoColorColumn(db);
  ensureFavorites(db);
  return db;
}
