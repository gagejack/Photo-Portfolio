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
import { listPhotos, getPhoto } from '../../src/db/photos.js';
import { listTree } from '../../src/db/categories.js';

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

test('the admin panel requires authentication', async () => {
  const { base, server, photosRoot, db } = await harness();
  const res = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(res.status, 302);
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
  await uploadAndWait(base, cookie, [[await jpegBlob(), 'shot.jpg']]);

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
  assert.equal(anon.status, 302);

  await waitForBatch(base, cookie, batchId);
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('an unknown batch id returns 404', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  const res = await fetch(`${base}/admin/upload/status/does-not-exist`, { headers: { cookie } });
  assert.equal(res.status, 404);
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});

test('a photo uploaded into a category lands in that category', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  await fetch(`${base}/admin/categories`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Kyoto&flag=jp',
  });
  const [category] = listTree(db);

  const form = new FormData();
  form.append('photos', await jpegBlob(), 'shot.jpg');
  form.append('categoryId', String(category.id));
  const res = await fetch(`${base}/admin/upload`, { method: 'POST', headers: { cookie }, body: form });
  const { batchId } = await res.json();
  await waitForBatch(base, cookie, batchId);

  assert.equal(listPhotos(db, { categoryId: category.id }).length, 1);
  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});
