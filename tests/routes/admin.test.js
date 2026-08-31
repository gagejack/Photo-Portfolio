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
import { listPhotos, getPhoto } from '../../src/db/photos.js';

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

test('a caption submitted through the edit form persists and reappears escaped', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const form = new FormData();
  form.append('photos', await jpegBlob(), 'shot.jpg');
  await fetch(`${base}/admin/upload`, { method: 'POST', headers: { cookie }, body: form });

  const [photo] = listPhotos(db, {});
  const caption = `Kyoto <b>at</b> night's edge`;

  await fetch(`${base}/admin/photos/${photo.id}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: `caption=${encodeURIComponent(caption)}`,
  });

  assert.equal(getPhoto(db, photo.id).caption, caption);

  const html = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  assert.doesNotMatch(html, /Kyoto <b>at<\/b> night/);
  assert.match(html, /Kyoto &lt;b&gt;at&lt;\/b&gt; night&#39;s edge/);

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});
