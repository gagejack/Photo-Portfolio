import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
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
  adminHash: await argon2.hash('correct-horse', { type: argon2.argon2id }),
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
  assert.match(html, /\/photos\/thumb\/a\.webp/);
  assert.match(html, /\/photos\/thumb\/c\.webp/);
  assert.match(html, /srcset="\/photos\/thumb\/a\.webp 800w, \/photos\/display\/a\.webp 2560w"/);
  server.close();
  db.close();
});

test('an authenticated visitor can traverse between the public grid and admin', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=g&password=correct-horse',
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const publicHtml = await (await fetch(`${base}/`, { headers: { cookie } })).text();
  assert.match(publicHtml, /<a class="admin-link" href="\/admin">Admin<\/a>/);
  assert.match(publicHtml, /<form class="logout" method="post" action="\/admin\/logout">/);

  const adminHtml = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  assert.match(adminHtml, /<a class="brand" href="\/">Gage Jack/);

  const logout = await fetch(`${base}/admin/logout`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'returnTo=%2F',
    redirect: 'manual',
  });
  assert.equal(logout.headers.get('location'), '/');

  const afterLogout = await fetch(`${base}/admin`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(afterLogout.headers.get('location'), '/admin/login');
  server.close();
  db.close();
});

test('photos appear newest first in the markup', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.indexOf('a.webp') < html.indexOf('c.webp'));
  server.close();
  db.close();
});

test('a category page includes descendants and excludes others', async () => {
  const { db } = seeded();
  const { server, base } = await listen(createApp({ db, config }));
  const html = await (await fetch(`${base}/c/urban`)).text();
  assert.match(html, /\/photos\/thumb\/a\.webp/);   // tagged Kyoto, a descendant of Urban
  assert.match(html, /\/photos\/thumb\/c\.webp/);   // tagged Urban directly
  assert.doesNotMatch(html, /\/photos\/thumb\/b\.webp/); // Cars
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

test('a category name is escaped in the filter links, not rendered as markup', async () => {
  const db = openDb(':memory:');
  createCategory(db, { name: '<img src=x onerror=alert(1)>', slug: 'xss' });
  const { server, base } = await listen(createApp({ db, config }));
  const html = await (await fetch(`${base}/`)).text();

  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.match(html, /&lt;img/);
  server.close();
  db.close();
});

test('the feed with zero photos renders the empty state instead of throwing', async () => {
  const db = openDb(':memory:');
  const { server, base } = await listen(createApp({ db, config }));
  const res = await fetch(`${base}/`);
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /No photos yet\./);
  server.close();
  db.close();
});

test('buildRail returns an empty array for no photos', () => {
  assert.deepEqual(buildRail([]), []);
});
