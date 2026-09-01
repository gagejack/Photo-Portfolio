CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT    NOT NULL UNIQUE,
  taken_at    TEXT    NOT NULL,
  date_source TEXT    NOT NULL CHECK (date_source IN ('exif','mtime','manual')),
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  caption     TEXT,
  dominant_color TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos (taken_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS categories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT    NOT NULL,
  slug      TEXT    NOT NULL,
  parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  flag      TEXT,
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_sibling_slug
  ON categories (COALESCE(parent_id, -1), slug);

CREATE TABLE IF NOT EXISTS photo_categories (
  photo_id    INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (photo_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_pc_category ON photo_categories (category_id);
