import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { openDb } from '../../src/db/index.js';
import { createCategory } from '../../src/db/categories.js';
import { insertPhoto, setPhotoCategories } from '../../src/db/photos.js';
import { createApp } from '../../src/app.js';
import { buildRail } from '../../frontend/src/layout.js';

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
  return { db };
}

const config = {
  sessionSecret: 's'.repeat(32),
  adminUser: 'g',
  adminHash: await argon2.hash('correct-horse', { type: argon2.argon2id }),
  photosRoot: '/tmp/nope',
  maxUploadBytes: 1000,
};

async function listen(app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('public UI routes serve the React application shell', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  for (const path of ['/', '/c/urban', '/other-projects', '/admin/login']) {
    const response = await fetch(`${base}${path}`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<div id="root"><\/div>/);
    assert.match(html, /\/assets\/index-/);
  }
  server.close(); db.close();
});

test('the admin UI route redirects anonymous visitors before serving React', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  const response = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/login');
  server.close(); db.close();
});

test('the feed API returns every photo newest first', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  const body = await (await fetch(`${base}/api/feed`)).json();
  assert.deepEqual(body.photos.map(photo => photo.filename), ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.deepEqual(body.categories.map(category => category.name), ['Urban', 'Cars']);
  server.close(); db.close();
});

test('category feeds include descendants and exclude other branches', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  const body = await (await fetch(`${base}/api/feed?category=urban`)).json();
  assert.deepEqual(body.photos.map(photo => photo.filename), ['a.jpg', 'c.jpg']);
  assert.equal(body.activeSlug, 'urban');
  server.close(); db.close();
});

test('an unknown category returns a JSON 404', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  const response = await fetch(`${base}/api/feed?category=nonexistent`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Category not found' });
  server.close(); db.close();
});

test('category names and empty feeds are represented safely as data', async () => {
  const db = openDb(':memory:');
  const name = '<img src=x onerror=alert(1)>';
  createCategory(db, { name, slug: 'xss' });
  const { server, base } = await listen(createApp({ db, config }));
  const body = await (await fetch(`${base}/api/feed`)).json();
  assert.equal(body.categories[0].name, name);
  assert.deepEqual(body.photos, []);
  server.close(); db.close();
});

test('buildRail groups only populated months newest first', () => {
  const rail = buildRail([
    { id: 1, takenAt: '2025-10-02T00:00:00Z' },
    { id: 2, takenAt: '2025-08-11T00:00:00Z' },
    { id: 3, takenAt: '2023-04-09T00:00:00Z' },
  ]);
  assert.deepEqual(rail.map(group => group.year), [2025, 2023]);
  assert.deepEqual(rail[0].months.map(month => month.label), ['October', 'August']);
  assert.equal(rail[0].months[0].firstPhotoId, 1);
  assert.deepEqual(buildRail([]), []);
});
