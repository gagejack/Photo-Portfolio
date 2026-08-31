# Async Photo Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multi-photo uploads fast and reliable by cutting per-photo CPU cost and moving image processing off the HTTP request into a background queue.

**Architecture:** Three independent layers. The pipeline (`src/images/pipeline.js`) gets cheaper per photo and gains a `2560px` display size. A new in-memory queue (`src/images/queue.js`) drains jobs across several workers. The upload route stages bytes to disk with multer, enqueues, and returns a `batchId` immediately; a new status endpoint reports progress, and the client polls it.

**Tech Stack:** Node 20+ ESM, Express 5, multer 2, sharp 0.35, better-sqlite3, `node:test` + `node:assert/strict`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-async-upload-design.md`

## Global Constraints

- ESM only (`"type": "module"`). Use `import`, never `require`.
- Tests use `node:test` and `node:assert/strict`. Run with `npm test`.
- No new npm dependencies. Everything here uses what is already installed.
- `DISPLAY_WIDTH` is `2560`, `THUMB_WIDTH` is `400`, WebP `effort` is `2`,
  display `quality` is `82`, thumb `quality` is `78`.
- `withoutEnlargement: true` stays on every resize: a photo narrower than the
  target must never be upscaled.
- Queue concurrency is `Math.min(os.cpus().length, 4)`.
- Poll interval is 700ms; client gives up after 10 minutes without progress.
- Finished batches are evicted 5 minutes after completion.
- `<photosRoot>/staging/` must never be served by `src/app.js`, exactly like
  `originals/`.
- Tests clean up their temp dirs (`rmSync(root, { recursive: true, force: true })`),
  matching the existing suites.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/images/pipeline.js` (modify) | Decode/resize/encode one photo. No queue or DB awareness. |
| `src/images/queue.js` (create) | Generic bounded worker pool + batch progress tracking. No DB or sharp import. |
| `src/routes/admin.js` (modify) | Wires multer disk staging, the queue, and the two HTTP endpoints together. Owns the DB calls. |
| `src/app.js` (modify) | Staging sweep on boot. |
| `public/js/upload.js` (modify) | Two-phase client: transfer, then poll. |
| `tests/images/pipeline.test.js` (modify) | Pipeline behaviour incl. all 8 EXIF orientations. |
| `tests/images/queue.test.js` (create) | Queue behaviour with a fake `processJob`. |
| `tests/routes/admin.test.js` (modify) | Async upload contract end to end. |

**Note on Task 1 vs Task 4:** Task 1 changes the pipeline only. Four existing
tests in `tests/routes/admin.test.js` assert that photos exist immediately after
the upload POST returns. Those stay true through Tasks 1-3 and are deliberately
rewritten in Task 4, when the route actually becomes async. Do not touch them
before Task 4.

---

### Task 1: Pipeline — cheaper, larger display

**Files:**
- Modify: `src/images/pipeline.js`
- Test: `tests/images/pipeline.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `processUpload({ buffer, mtime, photosRoot })` keeps its exact
  current signature and still resolves to
  `{ filename, takenAt, dateSource, width, height }`. Task 3 depends on this
  being unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `tests/images/pipeline.test.js`. Note the existing file already has a
`jpeg()` helper and a `tmpRoot()` helper — reuse them, do not redefine them.

```js
// Add this helper next to the existing `jpeg` helper at the top of the file.
async function orientedJpeg(orientation, w = 800, h = 400) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#4a7' } })
    .withMetadata({ orientation })
    .jpeg()
    .toBuffer();
}

test('records post-rotation dimensions for every EXIF orientation', async () => {
  // Orientations 5-8 transpose the image; 1-4 do not. The recorded width and
  // height must describe the image as a viewer sees it, after rotation.
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const root = tmpRoot();
    const transposed = orientation >= 5;
    const r = await processUpload({
      buffer: await orientedJpeg(orientation, 800, 400),
      mtime: new Date(),
      photosRoot: root,
    });
    assert.equal(r.width, transposed ? 400 : 800, `width for orientation ${orientation}`);
    assert.equal(r.height, transposed ? 800 : 400, `height for orientation ${orientation}`);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the display variant is capped at 2560px', async () => {
  const root = tmpRoot();
  const r = await processUpload({ buffer: await jpeg(6000, 4000), mtime: new Date(), photosRoot: root });
  const p = photoPaths(root, r.filename);
  assert.equal((await sharp(p.display).metadata()).width, 2560);
  assert.equal((await sharp(p.thumb).metadata()).width, 400);
  rmSync(root, { recursive: true, force: true });
});
```

Then update the existing `derivatives are resized and the original is untouched`
test, which currently asserts a 1600px display against a 2400px source. A
2400px-wide source is now below the 2560px cap, so it is no longer resized at
all. Change that assertion to:

```js
  assert.equal((await sharp(p.thumb).metadata()).width, 400);
  assert.equal((await sharp(p.display).metadata()).width, 2400); // under the 2560 cap, not upscaled
  assert.equal((await sharp(p.original).metadata()).width, 2400);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/images/pipeline.test.js`

Expected: the orientation test fails (current code measures dimensions with a
rotate pass and will actually pass this one), the 2560px test fails with
`Expected values to be strictly equal: 1600 !== 2560`, and the edited
`derivatives are resized` test fails with `1600 !== 2400`.

If the orientation test passes right away, that is expected and fine — it is a
regression guard for the change you are about to make. It must still pass in
Step 4.

- [ ] **Step 3: Implement**

In `src/images/pipeline.js`:

Change the width constants at the top of the file:

```js
const THUMB_WIDTH = 400;
const DISPLAY_WIDTH = 2560;

// sharp defaults to `effort: 4`. On a 2560px encode that costs roughly 600ms
// per photo and buys about 2KB of file size versus `effort: 2` — measured, see
// the design doc. Encoding, not decoding, dominates this pipeline.
const WEBP_EFFORT = 2;

// EXIF orientations 5-8 transpose the image; 1-4 leave the axes alone.
const TRANSPOSING_ORIENTATIONS = new Set([5, 6, 7, 8]);
```

Add `writeFile` to the imports and drop `writeFileSync`:

```js
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
```

Replace the body of the `try` block (the rotate-only pass and both renders) with:

```js
    // `.metadata()` on a `rotate()`-chained pipeline does NOT report swapped
    // width/height — it only surfaces the orientation tag. Rather than paying
    // for a full-size rotate pass just to measure the result (~380ms on a 21MB
    // file, all of it discarded), read the tag off the unchained input and
    // apply the swap ourselves.
    const transposed = TRANSPOSING_ORIENTATIONS.has(meta.orientation);
    rotatedWidth = transposed ? meta.height : meta.width;
    rotatedHeight = transposed ? meta.width : meta.height;

    // Decode once. The thumb is derived from the already-decoded display
    // buffer rather than decoding the original a second time; at 2560 to 400
    // the extra resampling step is not visible.
    const display = await sharp(buffer)
      .rotate()
      .resize({ width: DISPLAY_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82, effort: WEBP_EFFORT })
      .toBuffer();
    const thumb = await sharp(display)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78, effort: WEBP_EFFORT })
      .toBuffer();

    await writeFile(paths.original, buffer);
    await writeFile(paths.display, display);
    await writeFile(paths.thumb, thumb);
```

Leave `assertIsImage`, the `meta.width/height` validation above it, the `catch`
block, and the `extractDate` call exactly as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/images/pipeline.test.js`
Expected: PASS, all tests in the file including the pre-existing cleanup ones.

- [ ] **Step 5: Verify the whole suite still passes**

Run: `npm test`
Expected: PASS. The admin tests still pass here — the route is still synchronous.

- [ ] **Step 6: Measure the actual improvement**

The spec's estimate must be replaced with a real number. Run:

```bash
node -e "
const sharp=require('sharp');
(async()=>{
  const w=6000,h=4000;
  const px=Buffer.allocUnsafe(w*h*3);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*3, n=(Math.random()*18|0);
    px[i]=((x/w*200)+n)|0; px[i+1]=((y/h*180)+40+n)|0; px[i+2]=(140-(x/w*90)+n)|0;
  }
  const buf=await sharp(px,{raw:{width:w,height:h,channels:3}}).jpeg({quality:92}).toBuffer();
  const {mkdtempSync,rmSync}=require('node:fs'), {tmpdir}=require('node:os'), {join}=require('node:path');
  const {processUpload}=await import('./src/images/pipeline.js');
  const root=mkdtempSync(join(tmpdir(),'pp-bench-'));
  const t=Date.now();
  await processUpload({buffer:buf,mtime:new Date(),photosRoot:root});
  console.log('processUpload ms', Date.now()-t);
  rmSync(root,{recursive:true,force:true});
})();
"
```

Record the number in the commit message. Do not claim an improvement you have
not measured.

- [ ] **Step 7: Commit**

```bash
git add src/images/pipeline.js tests/images/pipeline.test.js
git commit -m "perf: halve per-photo cost and raise display to 2560px

Drop the full-size rotate pass whose only output was dimensions; derive
them from the EXIF orientation tag instead. Decode once and derive the
thumb from the display buffer. Set webp effort to 2, which is where most
of the remaining time was going.

Measured on a 6000x4000 photo-like JPEG: 984ms -> NNNms.

(Replace NNN with the number Step 6 actually printed. Do not commit a
figure you did not measure.)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: The queue

**Files:**
- Create: `src/images/queue.js`
- Test: `tests/images/queue.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createQueue({ processJob, concurrency?, retentionMs? })` returns
    `{ addBatch, getBatch }`.
  - `addBatch(jobs)` takes an array of arbitrary job objects, returns
    `{ batchId, total }` where `batchId` is a string.
  - `getBatch(batchId)` returns
    `{ total, done, failed, finished }` or `undefined` if unknown/evicted.
    `failed` is an array of `{ name, reason }`.
  - `processJob(job)` is an async callback supplied by the caller. It may throw;
    the queue catches. Job objects are opaque to the queue and passed through
    untouched, with one exception: a `name` string, read only for failure
    reporting. Task 4 passes `{ path, name, categoryId }`; the queue neither
    knows nor cares about `path` and `categoryId`.

The queue imports neither the database nor sharp. That keeps it testable with a
fake `processJob` and keeps `src/images/` free of database concerns, matching the
existing separation between `src/images/` and `src/db/`.

- [ ] **Step 1: Write the failing tests**

Create `tests/images/queue.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../../src/images/queue.js';

const tick = ms => new Promise(r => setTimeout(r, ms));

async function settle(queue, batchId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const b = queue.getBatch(batchId);
    if (b?.finished) return b;
    await tick(10);
  }
  throw new Error('batch did not finish in time');
}

test('every job runs and the batch reports finished', async () => {
  const seen = [];
  const queue = createQueue({ processJob: async job => { seen.push(job.name); } });
  const { batchId, total } = queue.addBatch([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);

  assert.equal(total, 3);
  const batch = await settle(queue, batchId);
  assert.equal(batch.done, 3);
  assert.equal(batch.failed.length, 0);
  assert.deepEqual(seen.sort(), ['a', 'b', 'c']);
});

test('no more jobs run at once than the concurrency limit', async () => {
  let running = 0;
  let peak = 0;
  const queue = createQueue({
    concurrency: 2,
    processJob: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick(20);
      running -= 1;
    },
  });
  const { batchId } = queue.addBatch(Array.from({ length: 8 }, (_, i) => ({ name: `p${i}` })));
  await settle(queue, batchId);
  assert.equal(peak, 2);
});

test('one failing job does not stop the rest of the batch', async () => {
  const queue = createQueue({
    processJob: async job => {
      if (job.name === 'bad') throw new Error('unsupported file type');
    },
  });
  const { batchId } = queue.addBatch([{ name: 'ok1' }, { name: 'bad' }, { name: 'ok2' }]);

  const batch = await settle(queue, batchId);
  assert.equal(batch.finished, true);
  assert.equal(batch.done, 2);
  assert.equal(batch.failed.length, 1);
  assert.equal(batch.failed[0].name, 'bad');
  assert.match(batch.failed[0].reason, /unsupported file type/);
});

test('progress is observable while the batch is still running', async () => {
  const queue = createQueue({ concurrency: 1, processJob: async () => tick(40) });
  const { batchId } = queue.addBatch([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);

  await tick(10);
  const mid = queue.getBatch(batchId);
  assert.equal(mid.finished, false);
  assert.ok(mid.done < 3, 'batch should not be complete yet');

  await settle(queue, batchId);
});

test('job objects reach processJob untouched', async () => {
  // The route layer passes { path, name, categoryId }; the queue must not
  // care about or mangle fields it does not understand.
  const received = [];
  const queue = createQueue({ processJob: async job => { received.push(job); } });
  const { batchId } = queue.addBatch([
    { path: '/tmp/staged-abc', name: 'shot.jpg', categoryId: '7' },
  ]);

  await settle(queue, batchId);
  assert.deepEqual(received, [
    { path: '/tmp/staged-abc', name: 'shot.jpg', categoryId: '7' },
  ]);
});

test('an unknown batch id returns undefined', () => {
  const queue = createQueue({ processJob: async () => {} });
  assert.equal(queue.getBatch('nope'), undefined);
});

test('a finished batch is evicted after its retention window', async () => {
  const queue = createQueue({ processJob: async () => {}, retentionMs: 50 });
  const { batchId } = queue.addBatch([{ name: 'a' }]);
  await settle(queue, batchId);
  assert.ok(queue.getBatch(batchId), 'batch is readable immediately after finishing');

  await tick(120);
  assert.equal(queue.getBatch(batchId), undefined);
});

test('batches submitted concurrently do not mix their progress', async () => {
  const queue = createQueue({ concurrency: 2, processJob: async () => tick(5) });
  const first = queue.addBatch([{ name: 'a' }, { name: 'b' }]);
  const second = queue.addBatch([{ name: 'c' }]);

  await settle(queue, first.batchId);
  await settle(queue, second.batchId);

  assert.equal(queue.getBatch(first.batchId).total, 2);
  assert.equal(queue.getBatch(second.batchId).total, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/images/queue.test.js`
Expected: FAIL — `Cannot find module '.../src/images/queue.js'`.

- [ ] **Step 3: Implement**

Create `src/images/queue.js`:

```js
// An in-memory job queue with a bounded worker pool.
//
// Deliberately knows nothing about photos, sharp, or the database: the caller
// supplies `processJob`. That keeps this file testable with a fake and keeps
// database concerns out of `src/images/`.
//
// State is lost on restart. That is the accepted trade-off for a single-admin
// site — see the design doc; anything staged before a restart is swept on boot.
import { randomUUID } from 'node:crypto';
import os from 'node:os';

const DEFAULT_CONCURRENCY = Math.min(os.cpus().length, 4);

// Five minutes is long enough for a client to notice its batch finished and
// short enough that a long-lived process does not accumulate dead batches.
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;

export function createQueue({
  processJob,
  concurrency = DEFAULT_CONCURRENCY,
  retentionMs = DEFAULT_RETENTION_MS,
} = {}) {
  const jobs = [];
  const batches = new Map();
  let active = 0;

  function finish(batchId) {
    const batch = batches.get(batchId);
    if (!batch || batch.finished) return;
    if (batch.done + batch.failed.length < batch.total) return;

    batch.finished = true;
    const timer = setTimeout(() => batches.delete(batchId), retentionMs);
    // Do not hold the event loop open just to evict a finished batch.
    timer.unref?.();
  }

  async function runOne(entry) {
    const batch = batches.get(entry.batchId);
    try {
      await processJob(entry.job);
      if (batch) batch.done += 1;
    } catch (err) {
      if (batch) batch.failed.push({ name: entry.job.name, reason: err.message });
    } finally {
      finish(entry.batchId);
    }
  }

  function pump() {
    while (active < concurrency && jobs.length > 0) {
      const entry = jobs.shift();
      active += 1;
      runOne(entry).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  function addBatch(list) {
    const batchId = randomUUID();
    batches.set(batchId, {
      total: list.length,
      done: 0,
      failed: [],
      finished: false,
    });

    for (const job of list) jobs.push({ batchId, job });

    // An empty batch is finished the moment it is created.
    if (list.length === 0) finish(batchId);
    pump();

    return { batchId, total: list.length };
  }

  function getBatch(batchId) {
    const batch = batches.get(batchId);
    if (!batch) return undefined;
    return {
      total: batch.total,
      done: batch.done,
      failed: batch.failed,
      finished: batch.finished,
    };
  }

  return { addBatch, getBatch };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/images/queue.test.js`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/images/queue.js tests/images/queue.test.js
git commit -m "feat: add a bounded in-memory job queue

Generic worker pool with per-batch progress tracking. Takes a
processJob callback rather than importing the database, so it stays
testable in isolation.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Staging sweep on boot

**Files:**
- Modify: `src/app.js`
- Modify: `src/images/pipeline.js` (one exported helper)
- Test: `tests/images/pipeline.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `stagingDir(photosRoot)` returns the staging path as a string;
  `sweepStaging(photosRoot)` deletes everything inside it and returns the number
  of files removed. Task 4 uses `stagingDir`.

Doing this before Task 4 means the staging directory has a defined owner and a
cleanup story before anything starts writing to it.

- [ ] **Step 1: Write the failing test**

Add to `tests/images/pipeline.test.js`. Add `mkdirSync` and `writeFileSync` to
the existing `node:fs` import at the top of that file, and add `stagingDir` and
`sweepStaging` to the existing import from `../../src/images/pipeline.js`.

```js
test('sweepStaging empties the staging directory', async () => {
  const root = tmpRoot();
  const dir = stagingDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'abandoned-1'), 'bytes');
  writeFileSync(join(dir, 'abandoned-2'), 'bytes');

  assert.equal(sweepStaging(root), 2);
  assert.equal(existsSync(join(dir, 'abandoned-1')), false);
  assert.ok(existsSync(dir), 'the directory itself survives');
  rmSync(root, { recursive: true, force: true });
});

test('sweepStaging on a missing directory is a no-op', () => {
  const root = tmpRoot();
  assert.equal(sweepStaging(root), 0);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/images/pipeline.test.js`
Expected: FAIL — `stagingDir is not a function` / import error.

- [ ] **Step 3: Implement**

In `src/images/pipeline.js`, add `readdirSync` and `existsSync` to the
`node:fs` import, then add these exports near `photoPaths`:

```js
export function stagingDir(photosRoot) {
  return join(photosRoot, 'staging');
}

// Staged bytes are only meaningful to the in-memory queue that referenced them.
// After a restart that queue is gone, so anything still here is orphaned.
export function sweepStaging(photosRoot) {
  const dir = stagingDir(photosRoot);
  if (!existsSync(dir)) return 0;
  const names = readdirSync(dir);
  for (const name of names) rmSync(join(dir, name), { force: true });
  return names.length;
}
```

In `src/app.js`, import it and call it during app construction, immediately
before the static mounts:

```js
import { sweepStaging } from './images/pipeline.js';
```

```js
  // Anything left in staging belongs to a queue that died with the last
  // process. Clear it before serving.
  const swept = sweepStaging(config.photosRoot);
  if (swept > 0) console.log(`swept ${swept} orphaned staging file(s)`);
```

Leave the comment and the two `express.static` mounts for `thumb` and `display`
exactly as they are. Do not add a mount for `staging`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/app.js src/images/pipeline.js tests/images/pipeline.test.js
git commit -m "feat: sweep orphaned staging files on boot

Staged bytes only mean something to the in-memory queue that referenced
them, so anything surviving a restart is garbage.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Async upload route and status endpoint

**Files:**
- Modify: `src/routes/admin.js`
- Test: `tests/routes/admin.test.js`

**Interfaces:**
- Consumes: `createQueue` (Task 2), `stagingDir` (Task 3), `processUpload` (Task 1).
- Produces:
  - `POST /admin/upload` responds `202` with `{ batchId, total }`.
  - `GET /admin/upload/status/:batchId` responds `200` with
    `{ total, done, failed, finished }`, or `404` `{ error: 'unknown batch' }`.

This is the task that changes observable behaviour, so it is also the task that
rewrites the four existing admin tests which assume synchronous processing.

- [ ] **Step 1: Rewrite the existing synchronous tests**

In `tests/routes/admin.test.js`, add this helper below the `jpegBlob` helper:

```js
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
```

Now rewrite the four tests that assume synchronous processing.

Replace `uploading a photo creates one row and three files` with:

```js
test('uploading a photo creates one row and three files', async () => {
  const { db, base, cookie, server, photosRoot } = await harness();
  await uploadAndWait(base, cookie, [[await jpegBlob(), 'shot.jpg']]);

  const photos = listPhotos(db, {});
  assert.equal(photos.length, 1);
  const p = photoPaths(photosRoot, photos[0].filename);
  assert.ok(existsSync(p.original) && existsSync(p.display) && existsSync(p.thumb));

  server.close(); db.close(); rmSync(photosRoot, { recursive: true, force: true });
});
```

Replace `uploading a non-image is reported without creating a row` with:

```js
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
```

In `deleting a photo removes its row and all three files` and in
`a caption submitted through the edit form persists and reappears escaped`,
replace the three-line upload block:

```js
  const form = new FormData();
  form.append('photos', await jpegBlob(), 'shot.jpg');
  await fetch(`${base}/admin/upload`, { method: 'POST', headers: { cookie }, body: form });
```

with:

```js
  await uploadAndWait(base, cookie, [[await jpegBlob(), 'shot.jpg']]);
```

- [ ] **Step 2: Write the new failing tests**

Append to `tests/routes/admin.test.js`:

```js
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
```

Add the imports these need to the top of the file:

```js
import { readdirSync } from 'node:fs';           // merge into the existing node:fs import
import { stagingDir } from '../../src/images/pipeline.js';  // merge into the existing pipeline import
import { listTree } from '../../src/db/categories.js';
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- tests/routes/admin.test.js`
Expected: FAIL — the POST returns 200 rather than 202, and
`/admin/upload/status/...` 404s because the route does not exist yet.

- [ ] **Step 4: Implement**

In `src/routes/admin.js`:

Add imports at the top:

```js
import { mkdirSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createQueue } from '../images/queue.js';
import { stagingDir } from '../images/pipeline.js';
```

Replace the multer setup inside `adminRouter` with disk staging, and build the
queue:

```js
  const staging = stagingDir(config.photosRoot);
  mkdirSync(staging, { recursive: true });

  // Bytes go straight to disk. Holding a 50-photo batch in memory is over a
  // gigabyte and risks an OOM kill on a small VPS.
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, staging),
      filename: (req, file, cb) => cb(null, randomUUID()),
    }),
    limits: { fileSize: config.maxUploadBytes },
  });

  // The queue is generic; this callback is where photo and database knowledge
  // lives. One job = one staged file.
  const queue = createQueue({
    async processJob({ path, name, categoryId }) {
      try {
        const buffer = await readFile(path);
        const meta = await processUpload({
          buffer,
          mtime: new Date(),
          photosRoot: config.photosRoot,
        });
        try {
          const id = insertPhoto(db, meta);
          if (categoryId) setPhotoCategories(db, id, [Number(categoryId)]);
        } catch (dbErr) {
          // Keep disk and database consistent: no orphaned files.
          removePhotoFiles(config.photosRoot, meta.filename);
          throw dbErr;
        }
      } finally {
        // The staged copy is temporary on every path, success or failure.
        await unlink(path).catch(() => {});
      }
    },
  });
```

Replace the whole `router.post('/admin/upload', ...)` handler with:

```js
  router.post('/admin/upload', requireAuth, upload.array('photos', 100), (req, res) => {
    const { batchId, total } = queue.addBatch(
      (req.files ?? []).map(file => ({
        path: file.path,
        name: file.originalname,
        categoryId: req.body.categoryId,
      }))
    );
    // 202: accepted, not yet processed. Progress is at the status endpoint.
    res.status(202).json({ batchId, total });
  });

  router.get('/admin/upload/status/:batchId', requireAuth, (req, res) => {
    const batch = queue.getBatch(req.params.batchId);
    if (!batch) return res.status(404).json({ error: 'unknown batch' });
    res.json(batch);
  });
```

`processUpload` and `removePhotoFiles` are already imported at the top of the
file — leave that import line alone.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/routes/admin.test.js`
Expected: PASS, including the four rewritten tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/admin.js tests/routes/admin.test.js
git commit -m "feat: process uploads on a background queue

The upload POST now stages bytes to disk and returns 202 with a batch
id; processing happens on the queue across several workers. Progress
moves to GET /admin/upload/status/:batchId.

This takes image processing off the request path, so a batch is no
longer racing Cloudflare's 100s cap, and photos are processed in
parallel rather than one at a time.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Two-phase client

**Files:**
- Modify: `public/js/upload.js`

**Interfaces:**
- Consumes: `POST /admin/upload` returning `{ batchId, total }` and
  `GET /admin/upload/status/:batchId` returning
  `{ total, done, failed, finished }` (Task 4).
- Produces: nothing consumed by later tasks.

There is no test suite for browser code in this repo and this task does not add
one — the verification step is a real upload in a browser. Do not invent a test
framework for this file.

- [ ] **Step 1: Implement**

In `public/js/upload.js`:

Replace the `CHUNK_SIZE` constant and its comment:

```js
  // Processing no longer happens inside the request, so a chunk only has to
  // survive its own transfer time against Cloudflare's 100s cap. Chunking is
  // kept so a dropped connection costs ten photos rather than the whole batch.
  const CHUNK_SIZE = 10;

  const POLL_MS = 700;
  // If nothing advances for this long, something is wrong server-side and the
  // poll should stop rather than spin forever.
  const STALL_TIMEOUT_MS = 10 * 60 * 1000;
```

Replace `sendChunk` so it returns the batch id:

```js
  async function sendChunk(files) {
    const data = new FormData();
    for (const f of files) data.append('photos', f);

    const params = new URLSearchParams(location.search);
    if (params.get('c')) data.append('categoryId', params.get('c'));

    const res = await fetch('/admin/upload', { method: 'POST', body: data });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    return res.json(); // { batchId, total }
  }
```

Add polling helpers below `showBar`:

```js
  async function fetchStatus(batchId) {
    const res = await fetch(`/admin/upload/status/${batchId}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    return res.json();
  }

  // Poll every batch until all of them report finished, reporting combined
  // progress. Returns the failures collected across all of them.
  async function awaitProcessing(batchIds, onProgress) {
    const failed = [];
    const pending = new Set(batchIds);
    let lastProgress = 0;
    let lastChange = Date.now();

    while (pending.size > 0) {
      await new Promise(r => setTimeout(r, POLL_MS));

      let done = 0;
      for (const batchId of [...pending]) {
        let status;
        try {
          status = await fetchStatus(batchId);
        } catch {
          // A transient failure should not abandon the batch; the stall
          // timeout below is what gives up.
          continue;
        }
        done += status.done + status.failed.length;
        if (status.finished) {
          failed.push(...status.failed);
          pending.delete(batchId);
        }
      }

      onProgress(done);

      if (done !== lastProgress) {
        lastProgress = done;
        lastChange = Date.now();
      } else if (Date.now() - lastChange > STALL_TIMEOUT_MS) {
        throw new Error('processing stalled — check the server');
      }
    }
    return failed;
  }
```

Replace `send` with the two-phase version:

```js
  async function send(files) {
    if (!files.length) return;

    const batches = chunk(files, CHUNK_SIZE);
    const bar = showBar(files.length);
    const batchIds = [];
    const allFailed = [];
    let transferred = 0;

    // Phase 1: transfer. The bar covers 0-50%.
    bar.label.textContent = 'Uploading photos';
    for (const batch of batches) {
      try {
        const { batchId } = await sendChunk(batch);
        batchIds.push(batchId);
      } catch (err) {
        for (const f of batch) allFailed.push({ name: f.name, reason: err.message });
      }
      transferred += batch.length;
      bar.update(transferred / 2);
    }

    // Phase 2: processing. The bar covers 50-100%. Transfer and processing are
    // genuinely two different waits — on a slow connection phase 1 dominates,
    // on a fast one phase 2 does — so showing them separately beats a bar that
    // sits at 100% during invisible server work.
    if (batchIds.length) {
      bar.label.textContent = 'Processing photos';
      try {
        const failed = await awaitProcessing(batchIds, done => {
          bar.update(files.length / 2 + done / 2);
        });
        allFailed.push(...failed);
      } catch (err) {
        progress.textContent = `Upload interrupted: ${err.message}`;
        return;
      }
    }

    if (allFailed.length) {
      const ok = files.length - allFailed.length;
      progress.textContent =
        `${ok} uploaded, ${allFailed.length} failed: ` +
        allFailed.map(f => `${f.name} (${f.reason})`).join(', ');
      setTimeout(() => location.reload(), 5000);
    } else {
      bar.label.textContent = 'Upload complete';
      bar.row.classList.add('done-fade');
      setTimeout(() => location.reload(), 500);
    }
  }
```

`showBar`'s `update` already rounds, so passing fractional counts is safe, but
make the counter read whole photos by changing `update` in `showBar` to:

```js
      update(done) {
        this.fill.style.width = `${Math.round((done / total) * 100)}%`;
        this.count.textContent = `${Math.round(done)} / ${total}`;
      },
```

Leave the `change` listener, the drag-and-drop listeners, and the comment about
the double-open file picker exactly as they are.

- [ ] **Step 2: Verify in a browser**

```bash
npm start
```

Open `http://127.0.0.1:3000/admin`, log in, and upload at least 12 photos at
once (more than one chunk) including at least one non-image file renamed to
`.jpg`. Confirm:

- The bar advances during transfer, then relabels to "Processing photos".
- The counter reaches `N / N`.
- The non-image is listed as failed with a reason.
- The page reloads and every valid photo is in the grid.
- `data/photos/staging/` is empty afterwards.

- [ ] **Step 3: Commit**

```bash
git add public/js/upload.js
git commit -m "feat: two-phase upload progress with status polling

The client now uploads in larger chunks, collects batch ids, and polls
for processing progress. The bar splits transfer (0-50%) from
processing (50-100%) because they are genuinely two different waits.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Verify end to end and record the result

**Files:**
- Modify: `docs/superpowers/specs/2026-08-31-async-upload-design.md`

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS. Paste the actual summary line into the commit message.

- [ ] **Step 2: Time a realistic batch**

With the server running, upload 20 full-size camera JPEGs through the browser
and time it with a stopwatch from drop to page reload. Record the number.

Compare against the old behaviour if you want a real before/after:
`git stash` is not enough here since the change spans several commits — use
`git worktree add ../pp-before 313c528` to get the pre-change code, run it on a
different port, and time the same 20 photos.

- [ ] **Step 3: Replace the estimate in the spec**

The spec's "Expected result" section contains an estimate. Replace it with the
measured per-photo figure from Task 1 Step 6 and the batch figure from Step 2
above. Delete the estimate language.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-31-async-upload-design.md
git commit -m "docs: record measured upload performance

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Follow-ups (not in this plan)

- Existing photos still have 1600px display files. A re-processing script would
  bring them up to 2560px.
- The queue is in memory; a restart mid-batch loses in-flight photos.
- The admin grid still waits for a full reload rather than showing photos as
  they finish.
