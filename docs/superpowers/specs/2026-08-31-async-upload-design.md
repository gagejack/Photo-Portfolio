# Async Upload Design

Date: 2026-08-31

## Problem

Uploading more than one photo at a time is slow and unreliable. In practice only
single-photo uploads succeed.

Two independent causes, both measured rather than guessed.

### Cause 1: the pipeline decodes each photo four times

`processUpload` in `src/images/pipeline.js` runs `sharp(buffer)` four separate
times per photo: once for `metadata()`, once for a rotate-only full-size pass
whose only purpose is reading post-rotation dimensions, then once each for the
display and thumb renders. Each is a full JPEG decode of a 20-50MB camera file.
The rotate-only pass re-encodes every pixel at full resolution and then discards
the result.

Measured on a synthetic 21MB 6000x4000 noise JPEG (noise, not a flat colour, so
the decode cost is realistic):

| Stage | Time |
|---|---|
| `metadata()` | ~0 ms |
| rotate-only full pass (dimensions only) | 378 ms |
| display render, 1600px | 422 ms |
| thumb render, 400px, from original | 184 ms |
| **total** | **~984 ms** |

Real camera files are larger than the test image, and EXIF extraction adds more
on top.

### Cause 2: the server processes photos one at a time

`router.post('/admin/upload')` in `src/routes/admin.js` loops
`for (const file of req.files)` with `await` inside. Photos are processed
strictly in sequence on a machine with 12 cores. A chunk of 3 photos therefore
costs three times the single-photo latency, and the whole batch is on the
critical path of one HTTP request.

That request runs through a Cloudflare tunnel, which caps a single request at
100 seconds. The client already works around this by uploading in chunks of 3
(`CHUNK_SIZE` in `public/js/upload.js`), which is a symptom fix: it makes the
requests short enough to survive without addressing why they are slow.

## Solution overview

Three changes, which can land in this order:

1. Make the pipeline cheaper per photo.
2. Take processing off the HTTP request entirely: stage bytes to disk, process
   them in a background queue, report progress by polling.
3. Update the client to drive the two-phase flow.

## Decisions taken

Recorded here because they shaped the design and are not recoverable from the
code:

- **Display width rises from 1600px to 2560px.** Visitors never see the
  originals; `originals/` is stored but not served (`src/app.js`). 2560px is
  sharp on Retina and 4K displays at roughly 600KB-1MB per photo.
- **The queue lives in memory.** A restart mid-batch loses the in-flight photos
  and they are re-uploaded by hand. Single admin user, testing phase; a
  SQLite-backed job table is not worth the resume path and stale-job cleanup.
- **Bytes are staged to disk, not held in RAM.** A 50-photo batch is over a
  gigabyte; buffering that in a JS array risks an OOM kill on a small VPS.
- **The client keeps uploading in chunks**, but larger ones. Chunking now only
  has to survive transfer time, not processing time.
- **The admin grid does not show photos appearing live.** The progress bar runs
  to completion and the page reloads, as it does today.

## Component 1: pipeline

`src/images/pipeline.js`

- `DISPLAY_WIDTH` becomes 2560. `THUMB_WIDTH` stays 400. `withoutEnlargement`
  stays set on both, so a photo narrower than the target is never upscaled.
- Delete the rotate-only full-size pass. Take `width`, `height` and
  `orientation` from `sharp(buffer).metadata()`, and swap width and height when
  `orientation` is 5, 6, 7 or 8 (the four EXIF orientations that transpose the
  image). This reads the JPEG header only.
- Decode once. Render the display image from `sharp(buffer).rotate()`, then
  derive the thumb by resizing the display *buffer* rather than decoding the
  original a second time. At 2560 to 400 the extra resampling step is not
  visible.
- Replace `writeFileSync` with `await writeFile` from `node:fs/promises`, so a
  worker does not block the event loop while writing 25MB.

- Set `effort: 2` on both WebP encodes.

### Why `effort: 2`

Measured after the first draft of this spec, and it changed the design. On the
21MB noise test image the redesigned pipeline came out at 989ms — no faster than
the 984ms it replaced, because the 2560px WebP encode consumed the entire saving.
Breaking that down:

| Stage, 2560px | Time |
|---|---|
| decode only | 212 ms |
| decode + resize, no encode | 248 ms |
| decode + resize + WebP `effort: 4` (sharp's default) | 860 ms |

Encoding, not decoding, is the dominant cost. Sweeping the effort setting on a
photo-like image (smooth gradients plus mild noise, which compresses like real
camera output) rather than pure noise:

| `effort` | Time | Output size |
|---|---|---|
| 4 (default) | 374 ms | 44 KB |
| 2 | 221 ms | 46 KB |
| 1 | 205 ms | 46 KB |

`effort: 2` is 41% faster for 2KB more per photo. `effort: 1` buys almost nothing
beyond that. Taking it.

### Expected result

Per-photo cost is expected to land near 550-600ms on the noise worst case, versus
984ms today, while raising display resolution from 1600px to 2560px. Real camera
photos compress far better than noise and should be well under that. The figure
to trust is the one measured after implementation, not this estimate — the first
estimate in this spec was wrong by a factor of two.

The larger win is Component 2: this cost moves off the HTTP request and runs
across several cores at once.

The riskiest part of this component is deriving dimensions from EXIF orientation
instead of measuring them. The current code carries a comment explaining that
`.metadata()` on a `rotate()`-chained pipeline does not report swapped
dimensions. That remains true and is not what this change relies on: metadata is
read from the *unchained* `sharp(buffer)`, and the swap is applied explicitly.
Tests must cover all eight orientation values.

### Existing photos

Photos already on disk keep their 1600px display files. Re-processing them to
2560px is out of scope here and is a follow-up task.

## Component 2: staging, queue, endpoints

### Staging

Multer switches from `memoryStorage` to `diskStorage`, writing into
`<photosRoot>/staging/`. Like `originals/`, this directory is not served by
`src/app.js`. The `fileSize` limit is unchanged.

### Queue

New file `src/images/queue.js`. No new dependency.

The queue does not import the database or the config. It exports a factory,
`createQueue({ processJob })`, where `processJob` is supplied by
`adminRouter` and closes over `db` and `config`. This keeps the queue
independently testable with a fake `processJob` and keeps `src/images/` free of
database concerns, matching the existing separation between `src/images/` and
`src/db/`.

- Module-level `jobs` array and `batches` Map, keyed by a random `batchId`.
- Each batch holds `{ total, done, failed[], createdAt, finished }`.
- A worker pool drains `jobs`. Concurrency is `os.cpus().length` capped at 4:
  sharp already uses several threads per image internally, so a higher limit
  oversubscribes the CPU rather than helping.
- Each worker loops: take a job, run `processUpload` against the staged file,
  insert the DB row, apply `categoryId` if present, unlink the staging file,
  increment `done`.
- A job that throws is caught per job. One corrupt file cannot kill a worker or
  stall the batch; its reason string is pushed to that batch's `failed[]`. The
  staging file is unlinked on the failure path too, so nothing accumulates.
- Finished batches are dropped from the Map five minutes after completion, so a
  long-lived process does not grow without bound.

### Endpoints

`POST /admin/upload` no longer processes anything. It creates a batch, pushes one
job per received file, and responds immediately with `{ batchId, total }`.
Response time becomes transfer time alone.

`GET /admin/upload/status/:batchId` returns `{ total, done, failed, finished }`.
Auth-guarded with `requireAuth`, like every other admin route. An unknown
`batchId` returns 404.

### Behaviour change

A file that fails validation no longer fails the upload request. It appears in
the status endpoint's `failed[]` instead. Same information, delivered later.

### Startup

The server sweeps `<photosRoot>/staging/` on boot and deletes whatever is there.
With an in-memory queue, anything staged before a restart is unreferenced.

## Component 3: client

`public/js/upload.js`

`CHUNK_SIZE` rises from 3 to 10. Chunking is kept rather than sending one large
POST so that a network failure costs ten photos rather than the whole batch.

The flow becomes two phases behind a single bar:

1. **Transfer.** Chunks are POSTed as they are today, but each returns
   `{ batchId, total }` quickly. Batch IDs are collected. The bar fills 0-50%,
   labelled "Uploading photos".
2. **Processing.** All collected batches are polled every 700ms and their `done`
   counts summed. The bar fills 50-100%, labelled "Processing photos". The
   counter continues to read `x / y` against the total file count.

The split is deliberate. Transfer and processing are genuinely two different
waits: on a slow connection phase 1 dominates, on a fast one phase 2 does. A
single bar that sat at 100% during invisible server work would read as a hang.

Polling stops once every batch reports `finished`, then the existing endgame runs
unchanged: failures are listed with reasons followed by a reload after 5s, or
"Upload complete" and a reload after 500ms.

If no batch makes progress for 10 minutes the poll gives up and tells the user to
check the server, so a wedged batch cannot spin forever.

The drag-and-drop path needs no changes; both entry points already call `send()`.

## Testing

Tests are written before the implementation, following the existing suites'
pattern.

`tests/images/pipeline.test.js` (update)

- Post-rotation width and height are correct for all eight EXIF orientation
  values. This is the highest-risk change in the design.
- Display output is at most 2560px wide; thumb output is at most 400px.
- An image narrower than the target is not upscaled.
- The existing "no files left behind when processing fails" test still passes.

`tests/routes/admin.test.js` (update)

- `POST /admin/upload` responds with a `batchId` before processing has finished.
- The status endpoint reports progress and eventually reports `finished`.
- A file that is not an image lands in `failed[]` rather than failing the POST.
- The status endpoint rejects unauthenticated requests.
- An unknown `batchId` returns 404.

`tests/images/queue.test.js` (new)

- The pool runs no more jobs concurrently than its limit.
- One job that throws does not prevent the rest of the batch from completing.
- Staging files are unlinked on both the success and the failure path.
- A finished batch is evicted from the Map after its retention window.

## Out of scope

- Re-processing existing photos to the new 2560px display width.
- Persisting the queue across restarts.
- Showing photos in the admin grid as they finish, without a reload.
- Serving original files to visitors.
