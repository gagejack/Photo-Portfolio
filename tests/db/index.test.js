import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../../src/db/index.js';

test('openDb creates tables and enforces foreign keys', () => {
  const db = openDb(':memory:');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert.ok(tables.includes('photos'));
  assert.ok(tables.includes('categories'));
  assert.ok(tables.includes('photo_categories'));

  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.close();
});

test('openDb adds dominant color storage to an existing database', () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-db-upgrade-'));
  const path = join(root, 'legacy.db');
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      taken_at TEXT NOT NULL,
      date_source TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      caption TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  legacy.close();

  const db = openDb(path);
  const columns = db.pragma('table_info(photos)').map(column => column.name);
  assert.ok(columns.includes('dominant_color'));
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('deleting a photo cascades to its category links', () => {
  const db = openDb(':memory:');
  const p = db.prepare(
    "INSERT INTO photos (filename,taken_at,date_source,width,height) VALUES ('a.jpg','2025-01-01T00:00:00Z','exif',100,100)"
  ).run();
  const c = db.prepare(
    "INSERT INTO categories (name,slug) VALUES ('Urban','urban')"
  ).run();
  db.prepare('INSERT INTO photo_categories VALUES (?,?)').run(
    p.lastInsertRowid, c.lastInsertRowid
  );

  db.prepare('DELETE FROM photos WHERE id = ?').run(p.lastInsertRowid);
  const links = db.prepare('SELECT COUNT(*) n FROM photo_categories').get();
  assert.equal(links.n, 0);
  db.close();
});

test('sibling slugs must be unique but may repeat under different parents', () => {
  const db = openDb(':memory:');
  const jp = db.prepare("INSERT INTO categories (name,slug) VALUES ('Japan','japan')").run();
  const us = db.prepare("INSERT INTO categories (name,slug) VALUES ('United States','united-states')").run();

  db.prepare("INSERT INTO categories (name,slug,parent_id) VALUES ('Kyoto','kyoto',?)").run(jp.lastInsertRowid);
  // same slug under a different parent is fine
  db.prepare("INSERT INTO categories (name,slug,parent_id) VALUES ('Kyoto','kyoto',?)").run(us.lastInsertRowid);

  // duplicate under the same parent is rejected
  assert.throws(() => {
    db.prepare("INSERT INTO categories (name,slug,parent_id) VALUES ('Kyoto Again','kyoto',?)")
      .run(jp.lastInsertRowid);
  }, /UNIQUE/);
  db.close();
});
