# Photo Portfolio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a chronological photography portfolio at gagejack.com with a private admin panel for uploading and organizing photos.

**Architecture:** One Express process serves both the public site and an authenticated `/admin` panel. Photo metadata lives in SQLite; image bytes live on the filesystem. Pages are server-rendered HTML with vanilla JavaScript for the timeline rail and lightbox — no client framework, no build step. Deployed as a systemd service bound to localhost, fronted by an existing Cloudflare Tunnel.

**Tech Stack:** Node.js (current LTS), Express 5, better-sqlite3, sharp, exifr, argon2, express-session, multer, node:test

**Spec:** `docs/superpowers/specs/2026-08-30-photo-portfolio-design.md`

## Global Constraints

- **Node.js:** current LTS. Server has none installed — install via NodeSource, not `apt install nodejs`.
- **Build toolchain:** `build-essential` required on the server for `better-sqlite3`. `sharp` uses prebuilt x86_64 binaries.
- **No client framework, no build step.** Vanilla JS only, served as static files.
- **No manual photo ordering anywhere.** Order is always `taken_at DESC, id DESC`.
- **Originals are never served to browsers.** Only `thumb` and `display` variants.
- **Test runner:** `node:test`, run with `node --test`. Tests live beside `src/` in `tests/`.
- **All SQL parameterized.** No string interpolation into queries.
- **Secrets in environment variables only.** Never committed. `.env` is gitignored.
- **Naming:** category display names capitalized (`Japan`, `Kyoto`). Slugs lowercase, hyphenated.
- **Server binds `127.0.0.1` only.** Never `0.0.0.0`.

## File Structure

```
src/
  db/
    schema.sql            Table definitions, indexes
    index.js              Connection, migration runner
    photos.js             Photo queries
    categories.js         Category queries, descendant expansion
  images/
    pipeline.js           sharp derivatives, hash naming
    exif.js               Date extraction with fallback
  web/
    layout.js             Justified row math
    render.js             HTML rendering helpers
    flags.js              ISO code to inline SVG
  routes/
    public.js             Feed, lightbox data
    admin.js              Upload, edit, delete, categories
    auth.js               Login, logout, session guard
  config.js               Env parsing, paths
  app.js                  Express wiring
  server.js               Entry point
public/
  css/site.css            Public styles
  css/admin.css           Admin styles
  js/rail.js              Radial timeline rail
  js/lightbox.js          Lightbox
  js/upload.js            Drag-drop upload
tests/
  <mirrors src/>
deploy/
  photoportfolio.service  systemd unit
  README.md               Server setup steps
```

Splits follow responsibility, not layer. `layout.js` holds pure row math with no Express or SQLite dependency, so it tests without fixtures. `categories.js` owns descendant expansion because that is the one genuinely tricky query. `pipeline.js` and `exif.js` split because EXIF parsing fails independently of resizing and needs its own fallback tests.

---

### Task 1: Project scaffold and configuration

**Files:**
- Create: `package.json`, `src/config.js`, `.env.example`
- Test: `tests/config.test.js`

**Interfaces:**
- Produces: `config` object with `{ port, host, dbPath, photosRoot, sessionSecret, adminUser, adminHash, maxUploadBytes }`

- [ ] **Step 1: Initialize package.json**

```bash
npm init -y
npm pkg set type=module
npm pkg set scripts.start="node src/server.js"
npm pkg set scripts.test="node --test"
npm pkg set engines.node=">=20"
```

- [ ] **Step 2: Install dependencies**

```bash
npm install express better-sqlite3 sharp exifr argon2 express-session multer
```

- [ ] **Step 3: Write the failing test**

```javascript
// tests/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig reads values from env', () => {
  const cfg = loadConfig({
    PORT: '3000',
    DB_PATH: '/data/app.db',
    PHOTOS_ROOT: '/data/photos',
    SESSION_SECRET: 's'.repeat(32),
    ADMIN_USER: 'gage',
    ADMIN_PASSWORD_HASH: '$argon2id$fake',
  });
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.dbPath, '/data/app.db');
  assert.equal(cfg.adminUser, 'gage');
});

test('loadConfig throws when a required secret is missing', () => {
  assert.throws(
    () => loadConfig({ PORT: '3000' }),
    /SESSION_SECRET/
  );
});

test('loadConfig rejects a short session secret', () => {
  assert.throws(
    () => loadConfig({
      SESSION_SECRET: 'tooshort',
      PHOTOS_ROOT: '/p',
      DB_PATH: '/d',
      ADMIN_USER: 'g',
      ADMIN_PASSWORD_HASH: 'h',
    }),
    /at least 32/
  );
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test tests/config.test.js`
Expected: FAIL — cannot find module `../src/config.js`

- [ ] **Step 5: Write the implementation**

```javascript
// src/config.js
function required(env, key) {
  const v = env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
  return v;
}

export function loadConfig(env = process.env) {
  const sessionSecret = required(env, 'SESSION_SECRET');
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return {
    port: Number(env.PORT ?? 3000),
    host: '127.0.0.1',
    dbPath: required(env, 'DB_PATH'),
    photosRoot: required(env, 'PHOTOS_ROOT'),
    sessionSecret,
    adminUser: required(env, 'ADMIN_USER'),
    adminHash: required(env, 'ADMIN_PASSWORD_HASH'),
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024),
  };
}
```

- [ ] **Step 6: Write .env.example**

```bash
PORT=3000
DB_PATH=./data/app.db
PHOTOS_ROOT=./data/photos
SESSION_SECRET=generate-with-openssl-rand-hex-32
ADMIN_USER=gage
ADMIN_PASSWORD_HASH=generate-with-npm-run-hash
MAX_UPLOAD_BYTES=52428800
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test tests/config.test.js`
Expected: PASS, 3 tests

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/config.js .env.example tests/config.test.js
git commit -m "feat: project scaffold and config loading"
```

---

### Task 2: Database schema and connection

**Files:**
- Create: `src/db/schema.sql`, `src/db/index.js`
- Test: `tests/db/index.test.js`

**Interfaces:**
- Consumes: `loadConfig` from Task 1
- Produces: `openDb(path) -> Database` — better-sqlite3 instance with schema applied, foreign keys and WAL enabled

- [ ] **Step 1: Write the schema**

```sql
-- src/db/schema.sql
CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT    NOT NULL UNIQUE,
  taken_at    TEXT    NOT NULL,
  date_source TEXT    NOT NULL CHECK (date_source IN ('exif','mtime','manual')),
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  caption     TEXT,
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
```

- [ ] **Step 2: Write the failing test**

```javascript
// tests/db/index.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/db/index.test.js`
Expected: FAIL — cannot find module `../../src/db/index.js`

- [ ] **Step 4: Write the implementation**

```javascript
// src/db/index.js
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/db/index.test.js`
Expected: PASS, 3 tests

- [ ] **Step 6: Commit**

```bash
git add src/db/ tests/db/
git commit -m "feat: database schema and connection"
```

---

### Task 3: Category queries and descendant expansion

**Files:**
- Create: `src/db/categories.js`
- Test: `tests/db/categories.test.js`

**Interfaces:**
- Consumes: `openDb` from Task 2
- Produces:
  - `createCategory(db, { name, slug, parentId, flag }) -> id`
  - `listTree(db) -> [{ id, name, slug, flag, parentId, position, children: [...], photoCount }]`
  - `descendantIds(db, categoryId) -> number[]` — includes the category itself
  - `renameCategory(db, id, name)`, `deleteCategory(db, id)`, `reparentCategory(db, id, parentId)`

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/db/categories.test.js`
Expected: FAIL — cannot find module `../../src/db/categories.js`

- [ ] **Step 3: Write the implementation**

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/db/categories.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/db/categories.js tests/db/categories.test.js
git commit -m "feat: category tree with descendant expansion"
```

---

### Task 4: Photo queries

**Files:**
- Create: `src/db/photos.js`
- Test: `tests/db/photos.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 2), `descendantIds` (Task 3)
- Produces:
  - `insertPhoto(db, { filename, takenAt, dateSource, width, height, caption }) -> id`
  - `listPhotos(db, { categoryId }) -> [{ id, filename, takenAt, width, height, caption }]` — ordered `taken_at DESC, id DESC`
  - `getPhoto(db, id)`, `deletePhoto(db, id)`
  - `setPhotoCategories(db, photoId, categoryIds)`
  - `updatePhoto(db, id, { caption, takenAt })` — setting `takenAt` sets `date_source` to `manual`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/db/photos.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/db/photos.test.js`
Expected: FAIL — cannot find module `../../src/db/photos.js`

- [ ] **Step 3: Write the implementation**

```javascript
// src/db/photos.js
import { descendantIds } from './categories.js';

const SELECT_COLS = `
  id, filename, taken_at AS takenAt, date_source AS dateSource,
  width, height, caption
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
    SELECT DISTINCT ${SELECT_COLS.replace(/\bid\b/, 'p.id')
      .replace(/\bfilename\b/, 'p.filename')
      .replace(/taken_at/, 'p.taken_at')
      .replace(/date_source/, 'p.date_source')
      .replace(/\bwidth\b/, 'p.width')
      .replace(/\bheight\b/, 'p.height')
      .replace(/\bcaption\b/, 'p.caption')}
    FROM photos p
    JOIN photo_categories pc ON pc.photo_id = p.id
    WHERE pc.category_id IN (${holes})
    ORDER BY p.taken_at DESC, p.id DESC
  `).all(...ids);
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
```

Note: the `SELECT_COLS.replace(...)` chain above is fragile. Replace it with an explicit aliased column list:

```javascript
const SELECT_P_COLS = `
  p.id, p.filename, p.taken_at AS takenAt, p.date_source AS dateSource,
  p.width, p.height, p.caption
`;
```

and use `SELECT DISTINCT ${SELECT_P_COLS}` in `listPhotos`. Do it this way from the start — do not write the `.replace()` version.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/db/photos.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/db/photos.js tests/db/photos.test.js
git commit -m "feat: photo queries with descendant-aware filtering"
```

---

### Task 5: EXIF date extraction

**Files:**
- Create: `src/images/exif.js`
- Test: `tests/images/exif.test.js`

**Interfaces:**
- Consumes: nothing from prior tasks
- Produces: `extractDate(buffer, fileMtime) -> { takenAt: string, source: 'exif'|'mtime' }` — `takenAt` is ISO 8601

- [ ] **Step 1: Write the failing test**

```javascript
// tests/images/exif.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { extractDate } from '../../src/images/exif.js';

async function plainJpeg() {
  return sharp({ create: { width: 10, height: 10, channels: 3, background: '#888' } })
    .jpeg().toBuffer();
}

test('falls back to mtime when EXIF has no date', async () => {
  const buf = await plainJpeg();
  const mtime = new Date('2024-03-05T12:00:00Z');
  const r = await extractDate(buf, mtime);
  assert.equal(r.source, 'mtime');
  assert.equal(r.takenAt, '2024-03-05T12:00:00.000Z');
});

test('reads DateTimeOriginal when present', async () => {
  const withExif = await sharp({
    create: { width: 10, height: 10, channels: 3, background: '#888' },
  })
    .withExif({ IFD0: { DateTimeOriginal: '2025:07:14 09:30:00' } })
    .jpeg()
    .toBuffer();

  const r = await extractDate(withExif, new Date('2000-01-01T00:00:00Z'));
  assert.equal(r.source, 'exif');
  assert.ok(r.takenAt.startsWith('2025-07-14'));
});

test('falls back to mtime on an unparseable buffer', async () => {
  const mtime = new Date('2022-11-11T00:00:00Z');
  const r = await extractDate(Buffer.from('not an image'), mtime);
  assert.equal(r.source, 'mtime');
  assert.equal(r.takenAt, '2022-11-11T00:00:00.000Z');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/images/exif.test.js`
Expected: FAIL — cannot find module `../../src/images/exif.js`

- [ ] **Step 3: Write the implementation**

```javascript
// src/images/exif.js
import exifr from 'exifr';

export async function extractDate(buffer, fileMtime) {
  try {
    const meta = await exifr.parse(buffer, ['DateTimeOriginal', 'CreateDate']);
    const raw = meta?.DateTimeOriginal ?? meta?.CreateDate;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      return { takenAt: raw.toISOString(), source: 'exif' };
    }
  } catch {
    // Unreadable or absent EXIF is expected for screenshots, scans, and
    // stripped files. Fall through to the mtime fallback.
  }
  return { takenAt: new Date(fileMtime).toISOString(), source: 'mtime' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/images/exif.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/images/exif.js tests/images/exif.test.js
git commit -m "feat: EXIF date extraction with mtime fallback"
```

---

### Task 6: Image pipeline

**Files:**
- Create: `src/images/pipeline.js`
- Test: `tests/images/pipeline.test.js`

**Interfaces:**
- Consumes: `extractDate` (Task 5)
- Produces:
  - `hashName(buffer) -> string` — 16-hex-char content hash
  - `processUpload({ buffer, mtime, photosRoot }) -> { filename, takenAt, dateSource, width, height }` — writes three files
  - `photoPaths(photosRoot, filename) -> { original, display, thumb }`
  - `removePhotoFiles(photosRoot, filename)`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/images/pipeline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { processUpload, hashName, photoPaths, removePhotoFiles } from '../../src/images/pipeline.js';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'pp-'));
}
async function jpeg(w = 2400, h = 1600) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#4a7' } })
    .jpeg().toBuffer();
}

test('processUpload writes original, display, and thumb', async () => {
  const root = tmpRoot();
  const buf = await jpeg();
  const r = await processUpload({ buffer: buf, mtime: new Date('2025-01-02T03:04:05Z'), photosRoot: root });

  const p = photoPaths(root, r.filename);
  assert.ok(existsSync(p.original));
  assert.ok(existsSync(p.display));
  assert.ok(existsSync(p.thumb));
  rmSync(root, { recursive: true, force: true });
});

test('records the original dimensions', async () => {
  const root = tmpRoot();
  const r = await processUpload({ buffer: await jpeg(2400, 1600), mtime: new Date(), photosRoot: root });
  assert.equal(r.width, 2400);
  assert.equal(r.height, 1600);
  rmSync(root, { recursive: true, force: true });
});

test('derivatives are resized and the original is untouched', async () => {
  const root = tmpRoot();
  const buf = await jpeg(2400, 1600);
  const r = await processUpload({ buffer: buf, mtime: new Date(), photosRoot: root });
  const p = photoPaths(root, r.filename);

  assert.equal((await sharp(p.thumb).metadata()).width, 400);
  assert.equal((await sharp(p.display).metadata()).width, 1600);
  assert.equal((await sharp(p.original).metadata()).width, 2400);
  rmSync(root, { recursive: true, force: true });
});

test('an image smaller than a target is not upscaled', async () => {
  const root = tmpRoot();
  const r = await processUpload({ buffer: await jpeg(300, 200), mtime: new Date(), photosRoot: root });
  const p = photoPaths(root, r.filename);
  assert.equal((await sharp(p.display).metadata()).width, 300);
  rmSync(root, { recursive: true, force: true });
});

test('the same bytes always produce the same filename', async () => {
  const buf = await jpeg();
  assert.equal(hashName(buf), hashName(Buffer.from(buf)));
});

test('a corrupt buffer throws and leaves no files behind', async () => {
  const root = tmpRoot();
  await assert.rejects(
    () => processUpload({ buffer: Buffer.from('garbage'), mtime: new Date(), photosRoot: root })
  );
  const leftover = existsSync(join(root, 'originals'))
    ? (await import('node:fs')).readdirSync(join(root, 'originals'))
    : [];
  assert.equal(leftover.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test('removePhotoFiles deletes all three variants', async () => {
  const root = tmpRoot();
  const r = await processUpload({ buffer: await jpeg(), mtime: new Date(), photosRoot: root });
  removePhotoFiles(root, r.filename);
  const p = photoPaths(root, r.filename);
  assert.ok(!existsSync(p.original));
  assert.ok(!existsSync(p.display));
  assert.ok(!existsSync(p.thumb));
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/images/pipeline.test.js`
Expected: FAIL — cannot find module `../../src/images/pipeline.js`

- [ ] **Step 3: Write the implementation**

```javascript
// src/images/pipeline.js
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { extractDate } from './exif.js';

const THUMB_WIDTH = 400;
const DISPLAY_WIDTH = 1600;

export function hashName(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

export function photoPaths(photosRoot, filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  return {
    original: join(photosRoot, 'originals', filename),
    display: join(photosRoot, 'display', `${base}.webp`),
    thumb: join(photosRoot, 'thumb', `${base}.webp`),
  };
}

export function removePhotoFiles(photosRoot, filename) {
  const p = photoPaths(photosRoot, filename);
  for (const f of [p.original, p.display, p.thumb]) {
    rmSync(f, { force: true });
  }
}

export async function processUpload({ buffer, mtime, photosRoot }) {
  // Validate and read dimensions before writing anything to disk.
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error('Unreadable image');

  const ext = meta.format === 'png' ? 'png' : 'jpg';
  const filename = `${hashName(buffer)}.${ext}`;
  const paths = photoPaths(photosRoot, filename);

  for (const dir of ['originals', 'display', 'thumb']) {
    mkdirSync(join(photosRoot, dir), { recursive: true });
  }

  try {
    // `rotate()` with no argument applies EXIF orientation.
    const base = () => sharp(buffer).rotate();
    const display = await base()
      .resize({ width: DISPLAY_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const thumb = await base()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();

    writeFileSync(paths.original, buffer);
    writeFileSync(paths.display, display);
    writeFileSync(paths.thumb, thumb);
  } catch (err) {
    removePhotoFiles(photosRoot, filename);
    throw err;
  }

  const { takenAt, source } = await extractDate(buffer, mtime);

  // Orientation may swap the visual dimensions; report what the viewer sees.
  const rotated = await sharp(buffer).rotate().metadata();

  return {
    filename,
    takenAt,
    dateSource: source,
    width: rotated.width,
    height: rotated.height,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/images/pipeline.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/images/pipeline.js tests/images/pipeline.test.js
git commit -m "feat: image pipeline with hash naming and derivatives"
```

---

### Task 6a: Reject non-images before processing

**Files:**
- Modify: `src/images/pipeline.js`
- Test: `tests/images/pipeline.test.js`

**Interfaces:**
- Produces: `assertIsImage(buffer)` — throws `Error('Unsupported file type')` when the bytes are not JPEG, PNG, WebP, HEIC, or AVIF

- [ ] **Step 1: Write the failing test**

```javascript
// append to tests/images/pipeline.test.js
import { assertIsImage } from '../../src/images/pipeline.js';

test('assertIsImage accepts a real JPEG', async () => {
  assertIsImage(await jpeg(10, 10));
});

test('assertIsImage rejects a PDF masquerading as .jpg', () => {
  const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n');
  assert.throws(() => assertIsImage(pdf), /Unsupported file type/);
});

test('assertIsImage rejects a text file', () => {
  assert.throws(() => assertIsImage(Buffer.from('hello world')), /Unsupported file type/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/images/pipeline.test.js`
Expected: FAIL — `assertIsImage` is not exported

- [ ] **Step 3: Write the implementation**

```javascript
// add to src/images/pipeline.js

// Magic-number sniffing. The spec requires content-based validation
// because a file extension is attacker-controlled.
const SIGNATURES = [
  { name: 'jpeg', bytes: [0xff, 0xd8, 0xff], offset: 0 },
  { name: 'png',  bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 },
  { name: 'webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  { name: 'heic', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
];

export function assertIsImage(buffer) {
  const ok = SIGNATURES.some(sig =>
    sig.bytes.every((b, i) => buffer[sig.offset + i] === b)
  );
  if (!ok) throw new Error('Unsupported file type');
}
```

Then call it as the first line of `processUpload`:

```javascript
export async function processUpload({ buffer, mtime, photosRoot }) {
  assertIsImage(buffer);
  const meta = await sharp(buffer).metadata();
  // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/images/pipeline.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/images/pipeline.js tests/images/pipeline.test.js
git commit -m "feat: reject non-image uploads by content sniffing"
```

---

### Task 7: Justified grid layout math

**Files:**
- Create: `src/web/layout.js`
- Test: `tests/web/layout.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `justify(photos, { containerWidth, targetHeight, gutter }) -> [{ height, items: [{ photo, width }] }]`

This module is pure arithmetic — no Express, no SQLite, no DOM. That is deliberate: the trickiest visual logic in the project gets the cheapest possible tests.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/web/layout.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { justify } from '../../src/web/layout.js';

const photo = (id, width, height) => ({ id, width, height });

test('every row fills the container width exactly', () => {
  const photos = Array.from({ length: 12 }, (_, i) =>
    photo(i, i % 2 ? 4000 : 3000, i % 3 ? 3000 : 4000)
  );
  const rows = justify(photos, { containerWidth: 1600, targetHeight: 320, gutter: 10 });

  for (const row of rows.slice(0, -1)) {
    const total =
      row.items.reduce((s, it) => s + it.width, 0) + (row.items.length - 1) * 10;
    assert.ok(Math.abs(total - 1600) < 1, `row width ${total} should be 1600`);
  }
});

test('aspect ratios are preserved within a row', () => {
  const photos = [photo(1, 4000, 2000), photo(2, 2000, 2000), photo(3, 3000, 2000)];
  const rows = justify(photos, { containerWidth: 1200, targetHeight: 300, gutter: 10 });
  for (const row of rows) {
    for (const item of row.items) {
      const original = item.photo.width / item.photo.height;
      assert.ok(Math.abs(item.width / row.height - original) < 0.01);
    }
  }
});

test('every photo appears exactly once, in order', () => {
  const photos = Array.from({ length: 17 }, (_, i) => photo(i, 3000 + i * 50, 2000));
  const rows = justify(photos, { containerWidth: 1600, targetHeight: 320, gutter: 10 });
  const ids = rows.flatMap(r => r.items.map(it => it.photo.id));
  assert.deepEqual(ids, photos.map(p => p.id));
});

test('the final row is not stretched beyond a sane height', () => {
  const photos = [photo(1, 4000, 2250)];
  const rows = justify(photos, { containerWidth: 1600, targetHeight: 320, gutter: 10 });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].height <= 320 * 1.5);
});

test('a narrow container puts one photo per row', () => {
  const photos = [photo(1, 4000, 3000), photo(2, 3000, 4000)];
  const rows = justify(photos, { containerWidth: 380, targetHeight: 320, gutter: 10 });
  assert.equal(rows.length, 2);
});

test('an empty input produces no rows', () => {
  assert.deepEqual(justify([], { containerWidth: 1600, targetHeight: 320, gutter: 10 }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/web/layout.test.js`
Expected: FAIL — cannot find module `../../src/web/layout.js`

- [ ] **Step 3: Write the implementation**

```javascript
// src/web/layout.js

/**
 * Group photos into rows that each fill `containerWidth` exactly.
 *
 * Photos are accumulated until their combined aspect ratio would make a row
 * shorter than `targetHeight`, then the row is scaled so its widths plus
 * gutters sum to the container width. Aspect ratios are never altered, so
 * nothing is cropped.
 */
export function justify(photos, { containerWidth, targetHeight, gutter }) {
  const rows = [];
  let current = [];
  let ratioSum = 0;

  const flush = (isLast) => {
    if (current.length === 0) return;
    const available = containerWidth - gutter * (current.length - 1);
    let height = available / ratioSum;

    // A trailing row with few photos would stretch absurdly tall; cap it
    // and let it end short rather than dominate the page.
    if (isLast && height > targetHeight * 1.5) height = targetHeight;

    rows.push({
      height: Math.round(height),
      items: current.map(p => ({
        photo: p,
        width: Math.round((p.width / p.height) * height),
      })),
    });
    current = [];
    ratioSum = 0;
  };

  for (const p of photos) {
    current.push(p);
    ratioSum += p.width / p.height;

    const available = containerWidth - gutter * (current.length - 1);
    if (available / ratioSum < targetHeight) flush(false);
  }
  flush(true);

  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/web/layout.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/web/layout.js tests/web/layout.test.js
git commit -m "feat: justified grid row layout"
```

---

### Task 8: Flags and HTML rendering helpers

**Files:**
- Create: `src/web/flags.js`, `src/web/render.js`
- Test: `tests/web/flags.test.js`, `tests/web/render.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `flagSvg(code) -> string` — inline SVG markup, or `''` for an unknown or null code
  - `escapeHtml(str) -> string`
  - `layoutPage({ title, body, styles, scripts }) -> string` — full HTML document

- [ ] **Step 1: Write the failing test**

```javascript
// tests/web/flags.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagSvg } from '../../src/web/flags.js';

test('returns inline SVG for a known code', () => {
  const svg = flagSvg('jp');
  assert.match(svg, /^<svg/);
  assert.match(svg, /viewBox/);
});

test('is case insensitive', () => {
  assert.equal(flagSvg('JP'), flagSvg('jp'));
});

test('returns an empty string for unknown or missing codes', () => {
  assert.equal(flagSvg('zz'), '');
  assert.equal(flagSvg(null), '');
  assert.equal(flagSvg(undefined), '');
});
```

```javascript
// tests/web/render.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, layoutPage } from '../../src/web/render.js';

test('escapeHtml neutralizes markup', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
  );
});

test('escapeHtml handles ampersands and apostrophes', () => {
  assert.equal(escapeHtml(`Tom & Jerry's`), 'Tom &amp; Jerry&#39;s');
});

test('layoutPage emits a complete document with the title escaped', () => {
  const html = layoutPage({ title: 'A & B', body: '<p>hi</p>', styles: ['/css/site.css'], scripts: [] });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<title>A &amp; B<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/site\.css">/);
  assert.match(html, /<p>hi<\/p>/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/web/flags.test.js tests/web/render.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```javascript
// src/web/flags.js

// Flat rectangle flags as inline SVG. No network fetch, no emoji font
// dependency, identical rendering everywhere. Add a country here when a
// new one is needed.
const FLAGS = {
  jp: '<rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="6" fill="#bc002d"/>',
  us: '<rect width="30" height="20" fill="#fff"/>' +
      '<g fill="#b22234">' +
      [0, 3.08, 6.16, 9.24, 12.32, 15.4, 18.48]
        .map(y => `<rect y="${y}" width="30" height="1.54"/>`).join('') +
      '</g><rect width="12" height="10.78" fill="#3c3b6e"/>',
  fr: '<rect width="10" height="20" fill="#002395"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#ed2939"/>',
  it: '<rect width="10" height="20" fill="#009246"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#ce2b37"/>',
  de: '<rect width="30" height="6.67" fill="#000"/><rect y="6.67" width="30" height="6.67" fill="#dd0000"/><rect y="13.34" width="30" height="6.66" fill="#ffce00"/>',
  ca: '<rect width="30" height="20" fill="#fff"/><rect width="7.5" height="20" fill="#d52b1e"/><rect x="22.5" width="7.5" height="20" fill="#d52b1e"/>',
  mx: '<rect width="10" height="20" fill="#006847"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#ce1126"/>',
};

export function flagSvg(code) {
  if (!code) return '';
  const inner = FLAGS[String(code).toLowerCase()];
  if (!inner) return '';
  return `<svg class="flag" viewBox="0 0 30 20" aria-hidden="true">${inner}</svg>`;
}
```

```javascript
// src/web/render.js
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ENTITIES[ch]);
}

export function layoutPage({ title, body, styles = [], scripts = [] }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${styles.map(s => `<link rel="stylesheet" href="${s}">`).join('\n')}
</head>
<body>
${body}
${scripts.map(s => `<script src="${s}" defer></script>`).join('\n')}
</body>
</html>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/web/flags.test.js tests/web/render.test.js`
Expected: PASS, 6 tests total

- [ ] **Step 5: Commit**

```bash
git add src/web/flags.js src/web/render.js tests/web/flags.test.js tests/web/render.test.js
git commit -m "feat: flag SVGs and HTML rendering helpers"
```

---

### Task 9: Authentication

**Files:**
- Create: `src/routes/auth.js`, `scripts/hash-password.js`
- Modify: `package.json` (add `hash` script)
- Test: `tests/routes/auth.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 1)
- Produces:
  - `authRouter(config) -> express.Router` — mounts `GET /admin/login`, `POST /admin/login`, `POST /admin/logout`
  - `requireAuth(req, res, next)` — redirects to `/admin/login` when `req.session.user` is absent

- [ ] **Step 1: Write the password hashing script**

```javascript
// scripts/hash-password.js
import argon2 from 'argon2';

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js <password>');
  process.exit(1);
}
console.log(await argon2.hash(password, { type: argon2.argon2id }));
```

```bash
npm pkg set scripts.hash="node scripts/hash-password.js"
```

- [ ] **Step 2: Write the failing test**

```javascript
// tests/routes/auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import argon2 from 'argon2';
import { authRouter, requireAuth } from '../../src/routes/auth.js';

async function makeApp() {
  const config = {
    adminUser: 'gage',
    adminHash: await argon2.hash('correct-horse', { type: argon2.argon2id }),
    sessionSecret: 's'.repeat(32),
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: config.sessionSecret, resave: false, saveUninitialized: false }));
  app.use(authRouter(config));
  app.get('/admin/secret', requireAuth, (req, res) => res.send('classified'));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('unauthenticated access to an admin route redirects to login', async () => {
  const { server, base } = await listen(await makeApp());
  const res = await fetch(`${base}/admin/secret`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/login');
  server.close();
});

test('correct credentials grant access', async () => {
  const { server, base } = await listen(await makeApp());
  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=gage&password=correct-horse',
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie, 'a session cookie should be set');

  const res = await fetch(`${base}/admin/secret`, { headers: { cookie } });
  assert.equal(await res.text(), 'classified');
  server.close();
});

test('a wrong password is rejected with a generic message', async () => {
  const { server, base } = await listen(await makeApp());
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=gage&password=wrong',
    redirect: 'manual',
  });
  const body = await res.text();
  assert.match(body, /invalid/i);
  assert.doesNotMatch(body, /password is incorrect|no such user/i);
  server.close();
});

test('a wrong username is rejected the same way', async () => {
  const { server, base } = await listen(await makeApp());
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=nobody&password=correct-horse',
    redirect: 'manual',
  });
  assert.match(await res.text(), /invalid/i);
  server.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/routes/auth.test.js`
Expected: FAIL — cannot find module `../../src/routes/auth.js`

- [ ] **Step 4: Write the implementation**

```javascript
// src/routes/auth.js
import express from 'express';
import argon2 from 'argon2';
import { layoutPage, escapeHtml } from '../web/render.js';

// In-memory attempt tracking. Single process, single account — a shared
// store would add a dependency for no gain.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(ip, { first: Date.now(), count: 1 });
  } else {
    rec.count += 1;
  }
}

function loginPage(error) {
  return layoutPage({
    title: 'Sign in',
    styles: ['/css/admin.css'],
    body: `
<div class="login">
  <h1>Gage Jack</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/admin/login">
    <input name="username" placeholder="Username" autocomplete="username" required>
    <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</div>`,
  });
}

export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect('/admin/login');
}

export function authRouter(config) {
  const router = express.Router();

  router.get('/admin/login', (req, res) => {
    if (req.session?.user) return res.redirect('/admin');
    res.send(loginPage(null));
  });

  router.post('/admin/login', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (tooManyAttempts(ip)) {
      return res.status(429).send(loginPage('Too many attempts. Try again later.'));
    }

    const { username, password } = req.body ?? {};

    // Always run a verification so timing does not reveal whether the
    // username existed.
    const hashToCheck = username === config.adminUser
      ? config.adminHash
      : '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';

    let ok = false;
    try {
      ok = await argon2.verify(hashToCheck, String(password ?? ''));
    } catch {
      ok = false;
    }

    if (!ok || username !== config.adminUser) {
      recordAttempt(ip);
      return res.status(401).send(loginPage('Invalid username or password.'));
    }

    attempts.delete(ip);
    req.session.regenerate(err => {
      if (err) return res.status(500).send(loginPage('Session error. Try again.'));
      req.session.user = config.adminUser;
      res.redirect('/admin');
    });
  });

  router.post('/admin/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
  });

  return router;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/routes/auth.test.js`
Expected: PASS, 4 tests

- [ ] **Step 6: Commit**

```bash
git add src/routes/auth.js scripts/hash-password.js package.json tests/routes/auth.test.js
git commit -m "feat: single-account authentication with rate limiting"
```

---

### Task 10: Express app wiring and public feed route

**Files:**
- Create: `src/app.js`, `src/server.js`, `src/routes/public.js`, `public/css/site.css`
- Test: `tests/routes/public.test.js`

**Interfaces:**
- Consumes: `openDb` (2), `listTree`/`descendantIds` (3), `listPhotos` (4), `justify` (7), `layoutPage`/`escapeHtml` (8), `authRouter` (9)
- Produces:
  - `createApp({ db, config }) -> express.Application`
  - `publicRouter(db) -> express.Router` — `GET /`, `GET /c/:slug`
  - `buildRail(photos) -> [{ year, months: [{ label, key, firstPhotoId }] }]`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/routes/public.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.js';
import { createCategory } from '../../src/db/categories.js';
import { insertPhoto, setPhotoCategories } from '../../src/db/photos.js';
import { createApp } from '../../src/app.js';
import { buildRail } from '../../src/routes/public.js';

function seeded() {
  const db = openDb(':memory:');
  const urban = createCategory(db, { name: 'Urban', slug: 'urban' });
  const kyoto = createCategory(db, { name: 'Kyoto', slug: 'kyoto', parentId: urban });
  const cars = createCategory(db, { name: 'Cars', slug: 'cars' });

  const a = insertPhoto(db, { filename: 'a.jpg', takenAt: '2025-10-02T00:00:00Z', dateSource: 'exif', width: 4000, height: 2250 });
  const b = insertPhoto(db, { filename: 'b.jpg', takenAt: '2025-08-11T00:00:00Z', dateSource: 'exif', width: 3000, height: 4000 });
  const c = insertPhoto(db, { filename: 'c.jpg', takenAt: '2023-04-09T00:00:00Z', dateSource: 'exif', width: 4000, height: 3000 });
  setPhotoCategories(db, a, [kyoto]);
  setPhotoCategories(db, b, [cars]);
  setPhotoCategories(db, c, [urban]);
  return { db, urban, kyoto, cars };
}

const config = {
  sessionSecret: 's'.repeat(32),
  adminUser: 'g',
  adminHash: 'x',
  photosRoot: '/tmp/nope',
  maxUploadBytes: 1000,
};

async function listen(app) {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('the feed renders the nav and every photo', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  const html = await (await fetch(`${base}/`)).text();

  assert.match(html, /Gage Jack/);
  assert.match(html, /Portfolio/);
  assert.match(html, /Other Projects/);
  assert.match(html, /a\.jpg/);
  assert.match(html, /c\.jpg/);
  server.close();
  db.close();
});

test('photos appear newest first in the markup', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.indexOf('a.jpg') < html.indexOf('c.jpg'));
  server.close();
  db.close();
});

test('a category page includes descendants and excludes others', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  const html = await (await fetch(`${base}/c/urban`)).text();
  assert.match(html, /a\.jpg/);   // tagged Kyoto, a descendant of Urban
  assert.match(html, /c\.jpg/);   // tagged Urban directly
  assert.doesNotMatch(html, /b\.jpg/); // Cars
  server.close();
  db.close();
});

test('an unknown category slug returns 404', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  assert.equal((await fetch(`${base}/c/nonexistent`)).status, 404);
  server.close();
  db.close();
});

test('buildRail groups months under years, newest first', () => {
  const rail = buildRail([
    { id: 1, takenAt: '2025-10-02T00:00:00Z' },
    { id: 2, takenAt: '2025-08-11T00:00:00Z' },
    { id: 3, takenAt: '2023-04-09T00:00:00Z' },
  ]);
  assert.deepEqual(rail.map(r => r.year), [2025, 2023]);
  assert.deepEqual(rail[0].months.map(m => m.label), ['October', 'August']);
  assert.equal(rail[0].months[0].firstPhotoId, 1);
});

test('buildRail omits periods with no photos', () => {
  const rail = buildRail([{ id: 1, takenAt: '2025-10-02T00:00:00Z' }]);
  assert.equal(rail.length, 1);
  assert.equal(rail[0].months.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/routes/public.test.js`
Expected: FAIL — cannot find module `../../src/app.js`

- [ ] **Step 3: Write the public router**

```javascript
// src/routes/public.js
import express from 'express';
import { listPhotos } from '../db/photos.js';
import { listTree } from '../db/categories.js';
import { justify } from '../web/layout.js';
import { layoutPage, escapeHtml } from '../web/render.js';

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const CONTAINER_WIDTH = 1600;
const TARGET_HEIGHT = 320;
const GUTTER = 10;

export function buildRail(photos) {
  const years = new Map();
  for (const p of photos) {
    const d = new Date(p.takenAt);
    const year = d.getUTCFullYear();
    const monthIdx = d.getUTCMonth();
    if (!years.has(year)) years.set(year, new Map());
    const months = years.get(year);
    if (!months.has(monthIdx)) {
      months.set(monthIdx, { label: MONTHS[monthIdx], key: `${year}-${monthIdx}`, firstPhotoId: p.id });
    }
  }
  return [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => ({
      year,
      months: [...months.entries()].sort((a, b) => b[0] - a[0]).map(([, m]) => m),
    }));
}

function flatten(tree, out = []) {
  for (const node of tree) {
    out.push(node);
    flatten(node.children, out);
  }
  return out;
}

function renderFeed({ photos, tree, activeSlug }) {
  const rows = justify(photos, {
    containerWidth: CONTAINER_WIDTH,
    targetHeight: TARGET_HEIGHT,
    gutter: GUTTER,
  });
  const rail = buildRail(photos);

  const filters = [
    `<a class="f ${activeSlug ? '' : 'on'}" href="/">All</a>`,
    ...tree.map(c =>
      `<a class="f ${activeSlug === c.slug ? 'on' : ''}" href="/c/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a>`
    ),
  ].join('');

  const grid = rows.map(row => `
    <div class="row" style="height:${row.height}px">
      ${row.items.map(it => `
        <div class="cell" style="width:${it.width}px">
          <img src="/photos/thumb/${escapeHtml(it.photo.filename.replace(/\.[^.]+$/, ''))}.webp"
               width="${it.width}" height="${row.height}"
               loading="lazy" alt="${escapeHtml(it.photo.caption ?? '')}"
               data-id="${it.photo.id}"
               data-full="/photos/display/${escapeHtml(it.photo.filename.replace(/\.[^.]+$/, ''))}.webp">
        </div>`).join('')}
    </div>`).join('');

  const railHtml = rail.map(y => `
    <div class="r-item r-year" data-key="${y.year}-${y.months[0].key.split('-')[1]}">${y.year}</div>
    ${y.months.map(m => `<div class="r-item r-month" data-key="${m.key}" data-photo="${m.firstPhotoId}">${m.label}</div>`).join('')}
  `).join('');

  return layoutPage({
    title: 'Gage Jack Portfolio',
    styles: ['/css/site.css'],
    scripts: ['/js/rail.js', '/js/lightbox.js'],
    body: `
<nav class="pnav">
  <div class="brand">Gage Jack</div>
  <div class="links"><a class="cur" href="/">Portfolio</a><a href="/other-projects">Other Projects</a></div>
</nav>
<div class="filters">${filters}</div>
<div class="stage">
  <div class="feed">${grid || '<p class="empty">No photos yet.</p>'}</div>
  <div class="rail"><div class="rail-inner">${railHtml}</div></div>
</div>
<div class="lightbox" id="lightbox" hidden>
  <button class="lb-close" aria-label="Close">&times;</button>
  <button class="lb-prev" aria-label="Previous">&#8249;</button>
  <img class="lb-img" alt="">
  <button class="lb-next" aria-label="Next">&#8250;</button>
</div>`,
  });
}

export function publicRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const photos = listPhotos(db, {});
    res.send(renderFeed({ photos, tree: listTree(db), activeSlug: null }));
  });

  router.get('/c/:slug', (req, res) => {
    const tree = listTree(db);
    const match = flatten(tree).find(c => c.slug === req.params.slug);
    if (!match) return res.status(404).send('Not found');
    const photos = listPhotos(db, { categoryId: match.id });
    res.send(renderFeed({ photos, tree, activeSlug: match.slug }));
  });

  router.get('/other-projects', (req, res) => {
    res.send(layoutPage({
      title: 'Other Projects',
      styles: ['/css/site.css'],
      body: `<nav class="pnav">
        <div class="brand">Gage Jack</div>
        <div class="links"><a href="/">Portfolio</a><a class="cur" href="/other-projects">Other Projects</a></div>
      </nav><div class="stage"><p class="empty">Coming soon.</p></div>`,
    }));
  });

  return router;
}
```

- [ ] **Step 4: Write the app wiring**

```javascript
// src/app.js
import express from 'express';
import session from 'express-session';
import { join } from 'node:path';
import { publicRouter } from './routes/public.js';
import { authRouter } from './routes/auth.js';

export function createApp({ db, config }) {
  const app = express();
  app.set('trust proxy', 1); // behind the Cloudflare tunnel

  app.use(express.urlencoded({ extended: false }));
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  }));

  app.use(express.static('public'));

  // Only derivatives are exposed. `originals/` is deliberately not served.
  app.use('/photos/thumb', express.static(join(config.photosRoot, 'thumb')));
  app.use('/photos/display', express.static(join(config.photosRoot, 'display')));

  app.use(authRouter(config));
  app.use(publicRouter(db));

  return app;
}
```

```javascript
// src/server.js
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = createApp({ db, config });

app.listen(config.port, config.host, () => {
  console.log(`Listening on http://${config.host}:${config.port}`);
});
```

- [ ] **Step 5: Write the public stylesheet**

```css
/* public/css/site.css */
:root { --ink: #333; --ink-soft: #555; --line: #f0f0f0; }
* { box-sizing: border-box; }
body {
  margin: 0; background: #fff; color: var(--ink);
  font: 400 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
a { color: inherit; text-decoration: none; }

/* Not sticky — the bar scrolls away with the content, leaving the
   photographs alone once the visitor starts scrolling. */
.pnav {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 20px 32px;
  background: #fff;
  border-bottom: 1px solid var(--line);
}
.pnav .brand { font-weight: 500; font-size: 15px; letter-spacing: -.01em; }
.pnav .links { display: flex; gap: 22px; font-size: 13px; color: var(--ink-soft); }
.pnav .links .cur { color: #111; }

.filters { display: flex; gap: 16px; flex-wrap: wrap; padding: 14px 32px 0; font-size: 12.5px; color: #999; }
.filters .f.on { color: #111; }

.stage { display: flex; padding: 18px 32px 80px; }
.feed { flex: 1; min-width: 0; max-width: 1600px; margin: 0 auto; }
.row { display: flex; gap: 10px; margin-bottom: 10px; }
.cell { overflow: hidden; }
.row img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 2px; cursor: pointer; }
.empty { color: #999; padding: 40px 0; }

.rail { width: 112px; flex: none; padding-left: 24px; }
.rail-inner { position: sticky; top: 96px; display: flex; flex-direction: column; align-items: flex-start; }
.r-item { cursor: pointer; white-space: nowrap; transform-origin: left center; line-height: 1; will-change: transform; }
.r-year { font-weight: 500; font-size: 13px; padding: 7px 0 3px; }
.r-month { font-size: 12px; padding: 3px 0; }

.lightbox {
  position: fixed; inset: 0; z-index: 50;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,.97);
}
.lightbox[hidden] { display: none; }
.lb-img { max-width: 92vw; max-height: 88vh; object-fit: contain; }
.lb-close, .lb-prev, .lb-next {
  position: absolute; background: none; border: 0; cursor: pointer;
  color: #555; font-size: 30px; line-height: 1; padding: 12px;
}
.lb-close { top: 14px; right: 20px; font-size: 26px; }
.lb-prev { left: 12px; }
.lb-next { right: 12px; }

@media (max-width: 720px) {
  .rail { display: none; }
  .stage, .filters, .pnav { padding-left: 16px; padding-right: 16px; }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tests/routes/public.test.js`
Expected: PASS, 6 tests

- [ ] **Step 7: Commit**

```bash
git add src/app.js src/server.js src/routes/public.js public/css/site.css tests/routes/public.test.js
git commit -m "feat: public feed with category filtering and timeline rail"
```

---

### Task 11: Client-side rail and lightbox

**Files:**
- Create: `public/js/rail.js`, `public/js/lightbox.js`

**Interfaces:**
- Consumes: markup emitted by `renderFeed` (Task 10) — `.r-item[data-key]`, `img[data-id][data-full]`, `#lightbox`
- Produces: no module exports; browser behavior only

These are verified by eye, not by assertion — the spec calls for manual judgment on the radial falloff and lightbox feel. No test step here is a deliberate choice, not an omission.

- [ ] **Step 1: Write the rail script**

```javascript
// public/js/rail.js
(function () {
  const items = [...document.querySelectorAll('.r-item')];
  const months = items.filter(el => el.classList.contains('r-month'));
  if (months.length === 0) return;

  const photos = [...document.querySelectorAll('.feed img[data-id]')];
  const byId = new Map(photos.map(img => [Number(img.dataset.id), img]));

  // Anchor each month to the first photo of that period.
  const anchors = months
    .map(el => ({ el, img: byId.get(Number(el.dataset.photo)) }))
    .filter(a => a.img);

  function focusIndex() {
    const line = window.innerHeight * 0.28;
    let idx = 0;
    anchors.forEach((a, i) => {
      if (a.img.getBoundingClientRect().top <= line) idx = i;
    });

    const cur = anchors[idx];
    const nxt = anchors[idx + 1];
    if (!nxt) return idx;

    const a = cur.img.getBoundingClientRect().top;
    const b = nxt.img.getBoundingClientRect().top;
    const frac = b > a ? Math.min(1, Math.max(0, (line - a) / (b - a))) : 0;
    return idx + frac;
  }

  function paint() {
    const f = focusIndex();
    const focused = anchors[Math.round(f)]?.el;

    items.forEach(el => {
      // Years take the distance of their nearest month.
      const isYear = el.classList.contains('r-year');
      const i = isYear
        ? anchors.findIndex(a => a.el.dataset.key === el.dataset.key)
        : anchors.findIndex(a => a.el === el);
      if (i < 0) return;

      const d = Math.abs(i - f);
      const t = Math.max(0, 1 - d / 4);
      const e = t * t * (3 - 2 * t);              // smoothstep
      const scale = 1 + e * (isYear ? 0.85 : 1.15);
      const grey = Math.round(215 - e * 200);

      el.style.transform = `scale(${scale.toFixed(3)})`;
      el.style.color = `rgb(${grey},${grey},${grey})`;
      el.style.opacity = (0.45 + e * 0.55).toFixed(3);
    });
  }

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { paint(); ticking = false; });
  }, { passive: true });

  items.forEach(el => {
    el.addEventListener('click', () => {
      const a = anchors.find(x => x.el.dataset.key === el.dataset.key);
      if (a) a.img.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  paint();
})();
```

- [ ] **Step 2: Write the lightbox script**

```javascript
// public/js/lightbox.js
(function () {
  const box = document.getElementById('lightbox');
  if (!box) return;

  const img = box.querySelector('.lb-img');
  const photos = [...document.querySelectorAll('.feed img[data-full]')];
  let index = -1;

  function show(i) {
    if (i < 0 || i >= photos.length) return;
    index = i;
    img.src = photos[i].dataset.full;
    img.alt = photos[i].alt || '';
    box.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function close() {
    box.hidden = true;
    img.src = '';
    document.body.style.overflow = '';
    if (index >= 0) photos[index].focus?.();
  }

  photos.forEach((p, i) => p.addEventListener('click', () => show(i)));

  box.querySelector('.lb-close').addEventListener('click', close);
  box.querySelector('.lb-prev').addEventListener('click', e => { e.stopPropagation(); show(index - 1); });
  box.querySelector('.lb-next').addEventListener('click', e => { e.stopPropagation(); show(index + 1); });

  // A click on the backdrop closes; a click on the image itself does not.
  box.addEventListener('click', e => { if (e.target === box) close(); });

  document.addEventListener('keydown', e => {
    if (box.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
  });
})();
```

- [ ] **Step 3: Verify by eye**

```bash
npm start
```

Open `http://127.0.0.1:3000` and confirm: the rail scales smoothly as you scroll with the focused month largest and darkest; clicking a month jumps to that period; clicking a photo opens it centered; arrow keys move through the feed; Escape and a backdrop click both close.

- [ ] **Step 4: Commit**

```bash
git add public/js/rail.js public/js/lightbox.js
git commit -m "feat: radial timeline rail and lightbox"
```

---

### Task 12: Admin panel

**Files:**
- Create: `src/routes/admin.js`, `public/css/admin.css`, `public/js/upload.js`
- Modify: `src/app.js` (mount the admin router)
- Test: `tests/routes/admin.test.js`

**Interfaces:**
- Consumes: everything above
- Produces: `adminRouter({ db, config }) -> express.Router` — `GET /admin`, `POST /admin/upload`, `POST /admin/photos/:id`, `POST /admin/photos/:id/delete`, `POST /admin/categories`, `POST /admin/categories/:id/delete`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/routes/admin.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import sharp from 'sharp';
import { openDb } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { photoPaths } from '../../src/images/pipeline.js';
import { listPhotos } from '../../src/db/photos.js';

async function harness() {
  const photosRoot = mkdtempSync(join(tmpdir(), 'pp-admin-'));
  const db = openDb(':memory:');
  const config = {
    sessionSecret: 's'.repeat(32),
    adminUser: 'gage',
    adminHash: await argon2.hash('pw', { type: argon2.argon2id }),
    photosRoot,
    maxUploadBytes: 10 * 1024 * 1024,
  };
  const app = createApp({ db, config });
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=gage&password=pw',
    redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { db, base, cookie, server, photosRoot };
}

async function jpegBlob() {
  const buf = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#a33' } })
    .jpeg().toBuffer();
  return new Blob([buf], { type: 'image/jpeg' });
}

test('the admin panel requires authentication', async () => {
  const { base, server, photosRoot, db } = await harness();
  const res = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('uploading a photo creates one row and three files', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const form = new FormData();
  form.append('photos', await jpegBlob(), 'shot.jpg');

  const res = await fetch(`${base}/admin/upload`, { method: 'POST', headers: { cookie }, body: form });
  assert.equal(res.status, 200);

  const photos = listPhotos(db, {});
  assert.equal(photos.length, 1);
  const p = photoPaths(photosRoot, photos[0].filename);
  assert.ok(existsSync(p.original) && existsSync(p.display) && existsSync(p.thumb));

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('uploading a non-image is reported without creating a row', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const form = new FormData();
  form.append('photos', new Blob(['not an image'], { type: 'image/jpeg' }), 'fake.jpg');

  const res = await fetch(`${base}/admin/upload`, { method: 'POST', headers: { cookie }, body: form });
  const body = await res.json();

  assert.equal(listPhotos(db, {}).length, 0);
  assert.equal(body.failed.length, 1);
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('deleting a photo removes its row and all three files', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const form = new FormData();
  form.append('photos', await jpegBlob(), 'shot.jpg');
  await fetch(`${base}/admin/upload`, { method: 'POST', headers: { cookie }, body: form });

  const [photo] = listPhotos(db, {});
  await fetch(`${base}/admin/photos/${photo.id}/delete`, { method: 'POST', headers: { cookie } });

  assert.equal(listPhotos(db, {}).length, 0);
  const p = photoPaths(photosRoot, photo.filename);
  assert.ok(!existsSync(p.original) && !existsSync(p.display) && !existsSync(p.thumb));

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('creating a category makes it visible on the public site', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  await fetch(`${base}/admin/categories`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Urban&flag=',
  });
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Urban/);
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/routes/admin.test.js`
Expected: FAIL — `/admin` is not mounted

- [ ] **Step 3: Write the admin router**

```javascript
// src/routes/admin.js
import express from 'express';
import multer from 'multer';
import { requireAuth } from './auth.js';
import { processUpload, removePhotoFiles } from '../images/pipeline.js';
import {
  insertPhoto, listPhotos, getPhoto, deletePhoto, setPhotoCategories, updatePhoto
} from '../db/photos.js';
import {
  listTree, createCategory, deleteCategory, renameCategory
} from '../db/categories.js';
import { layoutPage, escapeHtml } from '../web/render.js';
import { flagSvg } from '../web/flags.js';

const slugify = s => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function renderTree(nodes, depth = 0) {
  return nodes.map(n => `
    <div class="cat-row lvl${depth}" data-id="${n.id}">
      <span class="arrow">${n.children.length ? '▸' : ''}</span>
      ${n.flag ? flagSvg(n.flag) : '<span class="flagpad"></span>'}
      <a href="/admin?c=${n.id}">${escapeHtml(n.name)}</a>
      <span class="count">${n.photoCount}</span>
      <form method="post" action="/admin/categories/${n.id}/delete" class="inline">
        <button type="submit" title="Delete">&times;</button>
      </form>
    </div>
    ${n.children.length ? `<div class="kids">${renderTree(n.children, depth + 1)}</div>` : ''}
  `).join('');
}

function flatten(tree, out = []) {
  for (const n of tree) { out.push(n); flatten(n.children, out); }
  return out;
}

function renderAdmin({ db, activeId }) {
  const tree = listTree(db);
  const flat = flatten(tree);
  const active = activeId ? flat.find(c => c.id === Number(activeId)) : null;
  const photos = listPhotos(db, active ? { categoryId: active.id } : {});

  const thumbs = photos.map(p => `
    <div class="thumb" data-id="${p.id}">
      <img src="/photos/thumb/${escapeHtml(p.filename.replace(/\.[^.]+$/, ''))}.webp" alt="" loading="lazy">
      <form method="post" action="/admin/photos/${p.id}/delete">
        <button class="x" type="submit" aria-label="Delete">&times;</button>
      </form>
      <form method="post" action="/admin/photos/${p.id}" class="meta">
        <input type="date" name="takenAt" value="${escapeHtml(p.takenAt.slice(0, 10))}">
        <select name="categories" multiple size="3">
          ${flat.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
        <button type="submit">Save</button>
      </form>
    </div>`).join('');

  return layoutPage({
    title: 'Admin — Gage Jack Portfolio',
    styles: ['/css/admin.css'],
    scripts: ['/js/upload.js'],
    body: `
<div class="admin-top">
  <div class="brand">Gage Jack <span class="dim">/ admin</span></div>
  <form method="post" action="/admin/logout"><button type="submit">Log out</button></form>
</div>
<div class="admin-cols">
  <aside class="side">
    ${renderTree(tree)}
    <form method="post" action="/admin/categories" class="add-cat">
      <input name="name" placeholder="New category" required>
      <select name="parentId">
        <option value="">Top level</option>
        ${flat.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
      </select>
      <input name="flag" placeholder="Flag (jp)" maxlength="2">
      <button type="submit">Add</button>
    </form>
  </aside>
  <main class="main">
    <h3>${active ? escapeHtml(active.name) : 'All photos'}</h3>
    <div class="crumb">${photos.length} photos</div>
    <form id="uploader" method="post" action="/admin/upload" enctype="multipart/form-data">
      <label class="drop">
        Drop photos here, or click to choose files
        <input type="file" name="photos" multiple accept="image/*" hidden>
      </label>
    </form>
    <div id="progress"></div>
    <div class="thumbs">${thumbs || '<p class="dim">Nothing here yet.</p>'}</div>
  </main>
</div>`,
  });
}

export function adminRouter({ db, config }) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes },
  });

  router.get('/admin', requireAuth, (req, res) => {
    res.send(renderAdmin({ db, activeId: req.query.c }));
  });

  router.post('/admin/upload', requireAuth, upload.array('photos', 100), async (req, res) => {
    const uploaded = [];
    const failed = [];

    for (const file of req.files ?? []) {
      try {
        const meta = await processUpload({
          buffer: file.buffer,
          mtime: new Date(),
          photosRoot: config.photosRoot,
        });
        try {
          const id = insertPhoto(db, meta);
          if (req.body.categoryId) {
            setPhotoCategories(db, id, [Number(req.body.categoryId)]);
          }
          uploaded.push({ id, filename: meta.filename });
        } catch (dbErr) {
          // Keep disk and database consistent: no orphaned files.
          removePhotoFiles(config.photosRoot, meta.filename);
          throw dbErr;
        }
      } catch (err) {
        failed.push({ name: file.originalname, reason: err.message });
      }
    }

    res.json({ uploaded, failed });
  });

  router.post('/admin/photos/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const { caption, takenAt } = req.body;
    const patch = {};
    if (caption !== undefined) patch.caption = caption;
    if (takenAt) patch.takenAt = new Date(`${takenAt}T12:00:00Z`).toISOString();
    updatePhoto(db, id, patch);

    if (req.body.categories !== undefined) {
      const ids = [].concat(req.body.categories).filter(Boolean).map(Number);
      setPhotoCategories(db, id, ids);
    }
    res.redirect(req.get('referer') ?? '/admin');
  });

  router.post('/admin/photos/:id/delete', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const photo = getPhoto(db, id);
    if (photo) {
      deletePhoto(db, id);
      removePhotoFiles(config.photosRoot, photo.filename);
    }
    res.redirect(req.get('referer') ?? '/admin');
  });

  router.post('/admin/categories', requireAuth, (req, res) => {
    const { name, parentId, flag } = req.body;
    createCategory(db, {
      name: name.trim(),
      slug: slugify(name),
      parentId: parentId ? Number(parentId) : null,
      flag: flag ? flag.toLowerCase().slice(0, 2) : null,
    });
    res.redirect('/admin');
  });

  router.post('/admin/categories/:id/delete', requireAuth, (req, res) => {
    deleteCategory(db, Number(req.params.id));
    res.redirect('/admin');
  });

  return router;
}
```

- [ ] **Step 4: Mount it in `src/app.js`**

Add the import and mount it before `publicRouter` so `/admin` is matched first:

```javascript
import { adminRouter } from './routes/admin.js';
// ...
  app.use(authRouter(config));
  app.use(adminRouter({ db, config }));
  app.use(publicRouter(db));
```

- [ ] **Step 5: Write the upload script**

```javascript
// public/js/upload.js
(function () {
  const form = document.getElementById('uploader');
  if (!form) return;

  const input = form.querySelector('input[type=file]');
  const drop = form.querySelector('.drop');
  const progress = document.getElementById('progress');

  async function send(files) {
    if (!files.length) return;
    const data = new FormData();
    for (const f of files) data.append('photos', f);

    const params = new URLSearchParams(location.search);
    if (params.get('c')) data.append('categoryId', params.get('c'));

    progress.textContent = `Uploading ${files.length} photo${files.length > 1 ? 's' : ''}…`;

    try {
      const res = await fetch('/admin/upload', { method: 'POST', body: data });
      const result = await res.json();
      if (result.failed.length) {
        progress.textContent =
          `${result.uploaded.length} uploaded, ${result.failed.length} failed: ` +
          result.failed.map(f => `${f.name} (${f.reason})`).join(', ');
        setTimeout(() => location.reload(), 4000);
      } else {
        location.reload();
      }
    } catch (err) {
      progress.textContent = `Upload failed: ${err.message}`;
    }
  }

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => send([...input.files]));

  ['dragenter', 'dragover'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); })
  );
  drop.addEventListener('drop', e => send([...e.dataTransfer.files]));
})();
```

- [ ] **Step 6: Write the admin stylesheet**

```css
/* public/css/admin.css */
* { box-sizing: border-box; }
body {
  margin: 0; background: #fff; color: #333;
  font: 400 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
a { color: inherit; text-decoration: none; }
.dim { color: #bbb; }

.admin-top {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 24px; border-bottom: 1px solid #ececec;
}
.admin-top .brand { font-weight: 500; }
.admin-top button { background: none; border: 0; color: #888; cursor: pointer; font-size: 12px; }

.admin-cols { display: flex; min-height: calc(100vh - 54px); }

.side { width: 240px; flex: none; padding: 24px 0 22px 24px; border-right: 1px solid #f0f0f0; }
.cat-row { display: flex; align-items: center; gap: 6px; padding: 6px 0; font-size: 13.5px; }
.cat-row .arrow { width: 9px; flex: none; font-size: 9px; color: #999; }
.flag { width: 18px; height: 12px; flex: none; border: .5px solid rgba(0,0,0,.14); }
.flagpad { width: 18px; flex: none; }
.count { margin-left: auto; font-size: 11px; color: #bbb; }
.cat-row .inline { display: inline; }
.cat-row .inline button { background: none; border: 0; color: #ddd; cursor: pointer; padding: 0 8px 0 6px; }
.cat-row:hover .inline button { color: #c66; }
.lvl1 { padding-left: 15px; }
.lvl2 { padding-left: 32px; }
.lvl3 { padding-left: 48px; }
.kids { display: block; }

.add-cat { margin-top: 18px; display: flex; flex-direction: column; gap: 6px; padding-right: 24px; }
.add-cat input, .add-cat select, .add-cat button {
  font: inherit; font-size: 12px; padding: 5px 7px;
  border: 1px solid #e0e0e0; border-radius: 3px; background: #fff;
}
.add-cat button { cursor: pointer; }

.main { flex: 1; padding: 22px 26px; min-width: 0; }
.main h3 { font-weight: 500; font-size: 15px; margin: 0 0 3px; }
.crumb { font-size: 11.5px; color: #999; margin-bottom: 18px; }

.drop {
  display: block; border: 1px dashed #d0d0d0; border-radius: 4px;
  padding: 26px; text-align: center; font-size: 12.5px; color: #999;
  margin-bottom: 14px; cursor: pointer;
}
.drop.over { border-color: #888; color: #555; background: #fafafa; }
#progress { font-size: 12px; color: #777; margin-bottom: 14px; min-height: 16px; }

.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.thumb { position: relative; }
.thumb img { width: 100%; height: 110px; object-fit: cover; border-radius: 2px; display: block; }
.thumb .x {
  position: absolute; top: 5px; right: 5px; width: 18px; height: 18px;
  border: 0; border-radius: 50%; background: rgba(0,0,0,.55);
  color: #fff; font-size: 12px; line-height: 1; cursor: pointer;
}
.thumb .meta { display: flex; flex-direction: column; gap: 4px; margin-top: 5px; }
.thumb .meta input, .thumb .meta select, .thumb .meta button {
  font: inherit; font-size: 11px; padding: 3px 5px;
  border: 1px solid #e5e5e5; border-radius: 3px; background: #fff;
}
.thumb .meta button { cursor: pointer; }

.login { max-width: 280px; margin: 18vh auto; display: flex; flex-direction: column; gap: 10px; }
.login h1 { font-size: 16px; font-weight: 500; margin: 0 0 8px; }
.login form { display: flex; flex-direction: column; gap: 8px; }
.login input, .login button {
  font: inherit; padding: 9px 11px; border: 1px solid #e0e0e0; border-radius: 3px;
}
.login button { background: #333; color: #fff; border-color: #333; cursor: pointer; }
.error { color: #c33; font-size: 12.5px; margin: 0; }
```

- [ ] **Step 7: Run the full suite**

Run: `node --test`
Expected: PASS, all tests across every file

- [ ] **Step 8: Commit**

```bash
git add src/routes/admin.js src/app.js public/css/admin.css public/js/upload.js tests/routes/admin.test.js
git commit -m "feat: admin panel with upload, categorization, and deletion"
```

---

### Task 13: Deployment

**Files:**
- Create: `deploy/photoportfolio.service`, `deploy/README.md`

**Interfaces:**
- Consumes: the finished application
- Produces: no code; a reproducible server setup

- [ ] **Step 1: Write the systemd unit**

```ini
# deploy/photoportfolio.service
[Unit]
Description=Gage Jack Photo Portfolio
After=network.target

[Service]
Type=simple
User=gage
WorkingDirectory=/opt/photoportfolio
EnvironmentFile=/opt/photoportfolio/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# The process needs nothing outside its own directories.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/photoportfolio/data

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the deployment guide**

````markdown
# Deployment

Target: Ubuntu 26.04, x86_64. Verify package names against the machine —
26.04 is newer than the assistant's knowledge cutoff, so do not assume
these are correct without checking.

## 1. Install prerequisites

Neither Node nor a build toolchain is present on a fresh server.

```bash
# Node — the distribution package is too old; use NodeSource.
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs

# Required to compile better-sqlite3. sharp ships prebuilt x86_64 binaries.
sudo apt install -y build-essential

node --version   # confirm a current LTS
```

## 2. Deploy the application

```bash
sudo mkdir -p /opt/photoportfolio
sudo chown gage:gage /opt/photoportfolio
git clone <repo> /opt/photoportfolio
cd /opt/photoportfolio
npm ci --omit=dev
mkdir -p data/photos
```

## 3. Configure

```bash
cp .env.example .env
openssl rand -hex 32                    # paste as SESSION_SECRET
npm run hash -- 'your-password'         # paste as ADMIN_PASSWORD_HASH
chmod 600 .env
```

Set `DB_PATH=/opt/photoportfolio/data/app.db` and
`PHOTOS_ROOT=/opt/photoportfolio/data/photos`.

Never commit `.env`. It holds the only credentials guarding the admin panel.

## 4. Run as a service

```bash
sudo cp deploy/photoportfolio.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now photoportfolio
systemctl status photoportfolio
curl -I http://127.0.0.1:3000        # expect 200
```

## 5. Route gagejack.com through the tunnel

`cloudflared` is already installed. The domain's nameservers must point at
Cloudflare before `dns` will succeed.

```bash
cloudflared tunnel login
cloudflared tunnel create photoportfolio
cloudflared tunnel route dns photoportfolio gagejack.com
```

`/etc/cloudflared/config.yml`:

```yaml
tunnel: photoportfolio
credentials-file: /home/gage/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: gagejack.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

No inbound ports are opened. The application stays bound to localhost and
is reachable only through the tunnel.

## 6. Back up

Photos are the irreplaceable asset — originals cannot be regenerated.

`/etc/cron.daily/photoportfolio-backup`:

```bash
#!/bin/sh
set -e
sqlite3 /opt/photoportfolio/data/app.db \
  ".backup '/opt/backups/app-$(date +%F).db'"
rsync -a --delete /opt/photoportfolio/data/photos/ /opt/backups/photos/
find /opt/backups -name 'app-*.db' -mtime +30 -delete
```

```bash
sudo mkdir -p /opt/backups
sudo chmod +x /etc/cron.daily/photoportfolio-backup
```

Copy `/opt/backups` off the machine periodically. A backup on the same
disk does not survive the failure it exists to protect against.

## 7. Transferring photos from an SSD

Upload through the admin panel for normal use. For a large first import,
copy the files to the server and upload them in browser batches:

```bash
rsync -avP --progress /Volumes/YourSSD/photos/ gage@server:/home/gage/incoming/
```

Uploads are idempotent — filenames derive from a content hash, so
re-uploading the same file overwrites its own derivatives rather than
creating a duplicate.
````

- [ ] **Step 3: Verify the unit file parses**

```bash
systemd-analyze verify deploy/photoportfolio.service || true
```

This runs on the server, not the development machine. On macOS, skip it.

- [ ] **Step 4: Commit**

```bash
git add deploy/
git commit -m "docs: systemd unit and deployment guide"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Data model — photos, categories, join | 2, 3, 4 |
| Descendant expansion on filter | 3, 4, 10 |
| Image pipeline, three variants, hash naming | 6 |
| EXIF date with mtime fallback | 5 |
| Justified grid, capped 1600px, centered | 7, 10 |
| Nav bar, white page, dark gray text | 10 |
| Chronological ordering, no manual sort | 4, 10 |
| Radial timeline rail | 10, 11 |
| Lightbox | 10, 11 |
| Category filters | 10 |
| Admin panel, nested tree, flags | 8, 12 |
| Single-account auth, Argon2id, rate limit | 9 |
| Upload, edit, delete, categories | 12 |
| Error handling — non-image, corrupt, orphans | 6, 6a, 12 |
| Security — localhost bind, no originals served | 10 |
| systemd, Cloudflare Tunnel, backups | 13 |
| Testing strategy | throughout |

Every spec section maps to a task.

**Placeholder scan:** No TBDs. Every code step carries runnable code. The
one step without a test (Task 11) states why — the spec assigns those two
behaviors to manual judgment.

**Type consistency:** Verified across tasks — `photoPaths` and
`removePhotoFiles` (6) are consumed with matching signatures in 12;
`descendantIds` (3) in 4; `justify` (7) in 10; `requireAuth` (9) in 12;
`listPhotos` returns `takenAt`/`dateSource` camelCase throughout.

**One correction folded in:** Task 4's first draft built its filtered
query with a `.replace()` chain over a column-list string — fragile and
easy to break. The task now specifies an explicit aliased column list and
says not to write the replace version.
