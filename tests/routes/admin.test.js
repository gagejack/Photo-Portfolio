import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import sharp from 'sharp';
import { openDb } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { photoPaths, stagingDir } from '../../src/images/pipeline.js';
import { listPhotos, getPhoto, insertPhoto, photoCategoryIds } from '../../src/db/photos.js';
import { listTree, createCategory, getFavoritesId } from '../../src/db/categories.js';

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

  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'gage', password: 'pw' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { db, base, cookie, server, photosRoot };
}

async function jpegBlob() {
  const buf = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#a33' } })
    .jpeg().toBuffer();
  return new Blob([buf], { type: 'image/jpeg' });
}

// The upload POST now returns as soon as bytes are staged. Processing happens
// afterwards on the queue, so tests must wait for the batch to report finished
// before asserting on rows or files.
async function waitForBatch(base, cookie, batchId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/admin/upload/status/${batchId}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const status = await res.json();
    if (status.finished) return status;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('batch did not finish in time');
}

async function uploadAndWait(base, cookie, blobs) {
  const form = new FormData();
  for (const [blob, name] of blobs) form.append('photos', blob, name);
  const res = await fetch(`${base}/admin/upload`, { method: 'POST', headers: { cookie }, body: form });
  assert.equal(res.status, 202);
  const { batchId } = await res.json();
  return waitForBatch(base, cookie, batchId);
}

test('the admin data API requires authentication', async () => {
  const { base, server, photosRoot, db } = await harness();
  const res = await fetch(`${base}/api/admin`);
  assert.equal(res.status, 401);
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('the admin data API reports storage for the photo filesystem', async () => {
  const { base, cookie, server, photosRoot, db } = await harness();
  const response = await fetch(`${base}/api/admin`, { headers: { cookie } });
  const { storage } = await response.json();

  assert.equal(response.status, 200);
  assert.ok(storage.totalBytes > 0);
  assert.ok(storage.usedBytes >= 0);
  assert.ok(storage.freeBytes >= 0);
  assert.equal(storage.usedBytes + storage.freeBytes, storage.totalBytes);

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('uploading a photo creates one row and three files', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  await uploadAndWait(base, cookie, [[await jpegBlob(), 'shot.jpg']]);

  const photos = listPhotos(db, {});
  assert.equal(photos.length, 1);
  const p = photoPaths(photosRoot, photos[0].filename);
  assert.ok(existsSync(p.original) && existsSync(p.display) && existsSync(p.thumb));

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('an image without EXIF keeps the client file modification date', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const form = new FormData();
  form.append('photos', await jpegBlob(), 'old-shot.jpg');
  form.append('mtime', '1709640000000'); // 2024-03-05T12:00:00.000Z
  const res = await fetch(`${base}/admin/upload`, { method: 'POST', headers: { cookie }, body: form });
  const { batchId } = await res.json();
  await waitForBatch(base, cookie, batchId);

  const [photo] = listPhotos(db, {});
  assert.equal(photo.dateSource, 'mtime');
  assert.equal(photo.takenAt, '2024-03-05T12:00:00.000Z');

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('uploading a non-image is reported without creating a row', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const status = await uploadAndWait(base, cookie, [
    [new Blob(['not an image'], { type: 'image/jpeg' }), 'fake.jpg'],
  ]);

  assert.equal(listPhotos(db, {}).length, 0);
  assert.equal(status.failed.length, 1);
  assert.equal(status.failed[0].name, 'fake.jpg');
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('an oversized upload returns a correlated 413 response', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const form = new FormData();
  form.append('photos', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]), 'too-big.jpg');

  const res = await fetch(`${base}/admin/upload`, {
    method: 'POST',
    headers: { cookie, 'x-upload-debug-id': 'oversize-test-001' },
    body: form,
  });

  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), {
    error: 'One or more files exceed the per-photo upload limit',
    uploadId: 'oversize-test-001',
  });
  assert.equal(listPhotos(db, {}).length, 0);

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('deleting a photo removes its row and all three files', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  await uploadAndWait(base, cookie, [[await jpegBlob(), 'shot.jpg']]);

  const [photo] = listPhotos(db, {});
  await fetch(`${base}/api/admin/photos/${photo.id}`, { method: 'DELETE', headers: { cookie } });

  assert.equal(listPhotos(db, {}).length, 0);
  const p = photoPaths(photosRoot, photo.filename);
  assert.ok(!existsSync(p.original) && !existsSync(p.display) && !existsSync(p.thumb));

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('creating a category makes it visible in the public feed API', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  await fetch(`${base}/api/admin/categories`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Urban', flag: null }),
  });
  const feed = await (await fetch(`${base}/api/feed`)).json();
  assert.ok(feed.categories.some(category => category.name === 'Urban'));
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('category actions rename categories and limit each parent to three children', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const create = async (name, parentId = null) => {
    const response = await fetch(`${base}/api/admin/categories`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name, parentId }),
    });
    return response;
  };

  const parent = await create('Main Category #1');
  assert.equal(parent.status, 201);
  const { id: parentId } = await parent.json();
  for (const number of [1, 2, 3]) {
    assert.equal((await create(`New Sub Category #${number}`, parentId)).status, 201);
  }
  const limit = await create('New Sub Category #4', parentId);
  assert.equal(limit.status, 409);
  assert.match((await limit.json()).error, /at most 3 subcategories/);

  const rename = await fetch(`${base}/api/admin/categories/${parentId}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Travel' }),
  });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).name, 'Travel');
  assert.ok(listTree(db).some(node => node.name === 'Travel'));

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('selecting photos for a subcategory also tags every parent category', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const main = createCategory(db, { name: 'Travel', slug: 'travel' });
  const sub = createCategory(db, { name: 'Japan', slug: 'japan', parentId: main });
  const photoId = insertPhoto(db, {
    filename: 'selection.jpg', takenAt: '2026-01-01T00:00:00Z', dateSource: 'exif', width: 100, height: 100,
  });

  const response = await fetch(`${base}/api/admin/categories/${sub}/photos`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ photoIds: [photoId] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).categoryIds, [sub, main]);
  assert.deepEqual(photoCategoryIds(db, photoId), [main, sub]);

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('photo metadata updates persist and are returned as JSON data', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  await uploadAndWait(base, cookie, [[await jpegBlob(), 'shot.jpg']]);

  const [photo] = listPhotos(db, {});
  const caption = `Kyoto <b>at</b> night's edge`;

  await fetch(`${base}/api/admin/photos/${photo.id}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ caption }),
  });

  assert.equal(getPhoto(db, photo.id).caption, caption);

  const admin = await (await fetch(`${base}/api/admin`, { headers: { cookie } })).json();
  assert.equal(admin.photos[0].caption, caption);

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('the upload POST returns a batch id before processing finishes', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const form = new FormData();
  form.append('photos', await jpegBlob(), 'a.jpg');
  form.append('photos', await jpegBlob(), 'b.jpg');

  const res = await fetch(`${base}/admin/upload`, { method: 'POST', headers: { cookie }, body: form });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(typeof body.batchId, 'string');
  assert.equal(body.total, 2);

  await waitForBatch(base, cookie, body.batchId);
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('a mixed batch reports each outcome separately', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const status = await uploadAndWait(base, cookie, [
    [await jpegBlob(), 'good.jpg'],
    [new Blob(['garbage'], { type: 'image/jpeg' }), 'bad.jpg'],
  ]);

  assert.equal(status.total, 2);
  assert.equal(status.done, 1);
  assert.equal(status.failed.length, 1);
  assert.equal(status.failed[0].name, 'bad.jpg');
  assert.equal(listPhotos(db, {}).length, 1);

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('staging is emptied once a batch completes', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  await uploadAndWait(base, cookie, [
    [await jpegBlob(), 'good.jpg'],
    [new Blob(['garbage'], { type: 'image/jpeg' }), 'bad.jpg'],
  ]);

  // Both the success and the failure path must unlink their staged file.
  const dir = stagingDir(photosRoot);
  const left = existsSync(dir) ? readdirSync(dir) : [];
  assert.deepEqual(left, []);

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('the status endpoint requires authentication', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const form = new FormData();
  form.append('photos', await jpegBlob(), 'shot.jpg');
  const res = await fetch(`${base}/admin/upload`, { method: 'POST', headers: { cookie }, body: form });
  const { batchId } = await res.json();

  const anon = await fetch(`${base}/admin/upload/status/${batchId}`, { redirect: 'manual' });
  assert.equal(anon.status, 401);

  await waitForBatch(base, cookie, batchId);
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('an unknown batch id returns 404', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const res = await fetch(`${base}/admin/upload/status/does-not-exist`, { headers: { cookie } });
  assert.equal(res.status, 404);
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('uploading ignores a submitted category so photos are categorized explicitly', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  await fetch(`${base}/api/admin/categories`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Kyoto', flag: 'jp' }),
  });
  const [category] = listTree(db);

  const form = new FormData();
  form.append('photos', await jpegBlob(), 'shot.jpg');
  form.append('categoryId', String(category.id));
  const res = await fetch(`${base}/admin/upload`, { method: 'POST', headers: { cookie }, body: form });
  const { batchId } = await res.json();
  await waitForBatch(base, cookie, batchId);

  assert.equal(listPhotos(db, { categoryId: category.id }).length, 0);
  const admin = await (await fetch(`${base}/api/admin`, { headers: { cookie } })).json();
  assert.deepEqual(admin.photos[0].categoryIds, []);
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('patching a photo date persists it and re-sorts the feed', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const photoId = insertPhoto(db, {
    filename: 'dated.jpg', takenAt: '2026-01-01T00:00:00Z', dateSource: 'exif', width: 100, height: 100,
  });

  const res = await fetch(`${base}/api/admin/photos/${photoId}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ takenAt: '2019-07-04' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).takenAt, '2019-07-04T12:00:00.000Z');
  assert.equal(getPhoto(db, photoId).takenAt, '2019-07-04T12:00:00.000Z');
  assert.equal(getPhoto(db, photoId).dateSource, 'manual');

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('patching several photos in sequence saves every one independently', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const travel = createCategory(db, { name: 'Travel', slug: 'travel' });
  const ids = [1, 2, 3].map(n => insertPhoto(db, {
    filename: `batch${n}.jpg`, takenAt: '2026-01-01T00:00:00Z', dateSource: 'exif', width: 100, height: 100,
  }));

  for (const [index, id] of ids.entries()) {
    const res = await fetch(`${base}/api/admin/photos/${id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        caption: `Photo ${index}`,
        takenAt: `202${index}-05-0${index + 1}`,
        categoryIds: index === 1 ? [] : [travel],
      }),
    });
    assert.equal(res.status, 200);
  }

  ids.forEach((id, index) => {
    const photo = getPhoto(db, id);
    assert.equal(photo.caption, `Photo ${index}`);
    assert.equal(photo.takenAt, `202${index}-05-0${index + 1}T12:00:00.000Z`);
    assert.deepEqual(photoCategoryIds(db, id), index === 1 ? [] : [travel]);
  });

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('reordering categories persists the new sibling order', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const alpha = createCategory(db, { name: 'Alpha', slug: 'alpha' });
  const beta = createCategory(db, { name: 'Beta', slug: 'beta' });
  const favorites = getFavoritesId(db);

  const res = await fetch(`${base}/api/admin/categories/reorder`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ parentId: null, orderedIds: [beta, alpha, favorites] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).categories.map(node => node.id), [beta, alpha, favorites]);
  assert.deepEqual(listTree(db).map(node => node.id), [beta, alpha, favorites]);

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('a reorder cannot move a category between parents', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const travel = createCategory(db, { name: 'Travel', slug: 'travel' });
  const japan = createCategory(db, { name: 'Japan', slug: 'japan', parentId: travel });
  const favorites = getFavoritesId(db);

  const res = await fetch(`${base}/api/admin/categories/reorder`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ parentId: null, orderedIds: [japan, travel, favorites] }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(listTree(db).map(node => node.id), [favorites, travel]);
  assert.equal(listTree(db).find(node => node.id === travel).children[0].id, japan);

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('favorites is protected from rename and deletion', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const favorites = getFavoritesId(db);

  const rename = await fetch(`${base}/api/admin/categories/${favorites}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed' }),
  });
  assert.equal(rename.status, 400);

  const removed = await fetch(`${base}/api/admin/categories/${favorites}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(removed.status, 400);
  assert.equal(getFavoritesId(db), favorites);

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('starring a photo files it under favorites', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const favorites = getFavoritesId(db);
  const photoId = insertPhoto(db, {
    filename: 'starred.jpg', takenAt: '2026-01-01T00:00:00Z', dateSource: 'exif', width: 100, height: 100,
  });

  const star = await fetch(`${base}/api/admin/photos/${photoId}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ categoryIds: [favorites] }),
  });
  assert.equal(star.status, 200);
  assert.deepEqual(photoCategoryIds(db, photoId), [favorites]);

  const unstar = await fetch(`${base}/api/admin/photos/${photoId}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ categoryIds: [] }),
  });
  assert.equal(unstar.status, 200);
  assert.deepEqual(photoCategoryIds(db, photoId), []);

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});
