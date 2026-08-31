# Image Upload Efficiency To-Do

## Goal

Make selecting multiple photos feel responsive, transfer them reliably, and
process them without making the upload request wait for image conversion.

## Current behavior

- The browser creates a one-photo upload request for each selected file.
- It keeps at most two one-photo requests active at once.
- The server stages each file to disk, then queues it for
  background processing.
- The background queue can process up to four photos at once.

The uploader intentionally sends one photo per request for reliability, so a
failed multipart request cannot fail an entire multi-photo selection. A
two-worker client queue improves transfer throughput while keeping that
failure isolation.

## Progress so far

- [x] Changed the client uploader to one file per request.
- [x] Added a bounded two-worker upload queue.
- [x] Confirmed that a batch continues after individual failures: 14 photos
      uploaded and 3 did not.
- [ ] Complete a timed, log-correlated baseline run before tuning throughput.
- [ ] Identify the failed PNG filenames and verify or re-export them before
      treating the failures as an upload problem.

The observed `vipspng: libpng read error` is emitted while Sharp/libvips
decodes a PNG after it reaches the server. It is an image-file decoding failure,
not evidence that the upload queue failed.

## Implementation order

Work through the sections in order. Measure after each one, and keep the
change only if it improves the test batch without reducing reliability.

### 1. Establish a baseline

- [ ] Choose a representative test batch: 12-20 real camera photos.
- [ ] Record total file size, number of photos, connection type, and total
      time from file selection to completion.
- [ ] In browser DevTools, use the Network tab to confirm how many
      `POST /admin/upload` requests are active at once.
- [ ] In the server logs, save the existing `[upload] request finished` lines
      for the same run.

**Success:** We know whether time is spent transferring bytes or processing
images, and have a number to compare each change against.

#### Baseline runbook

Run this against the deployed app at `https://gagejack.com` before changing
the uploader further. Use the same 20 representative camera photos for every
later comparison; record the exact file count, total bytes, and largest file.

1. Connect to the production server and start a live service-log tail:

   ```bash
   journalctl -u photoportfolio -f
   ```

2. Open `/admin` in the browser, then open DevTools:
   - In **Console**, enable Preserve log.
   - In **Network**, enable Preserve log and Disable cache, then filter for
     `admin/upload`.
   - Use your normal connection; do not enable artificial throttling for this
     first measurement.

3. Record the current date/time, connection type, and deployed revision if it
   is known. Start a timer immediately before selecting the fixed 20-photo
   batch.

4. During the upload, capture all of the following:
   - Each browser `[upload] sending chunk` and `[upload] chunk queued` entry,
     including its `uploadId`, number of files, and byte count.
   - The Network waterfall for each `POST /admin/upload`, including how many
     requests overlap.
   - The matching server `[upload] request finished` entries. Match these by
     `uploadId`; each includes the request's byte count and elapsed time.
   - The time when the UI reports `Upload complete`, plus the success and
     failure count.

5. Save a screenshot or HAR export of the filtered Network waterfall and copy
   the values into the results table below. These are the comparison point for
   future performance changes.

| Field | Baseline result |
| --- | --- |
| Test date/time | |
| Deployed revision | |
| Connection type | |
| Photo count | 17 in initial reliability test; use 20 for the timed baseline |
| Total bytes | |
| Largest file | |
| Active upload requests (maximum) | |
| Browser transfer phase duration | |
| Server request duration(s) | |
| Selection-to-complete duration | |
| Successful / failed photos | 14 / 3 in initial reliability test |
| Network waterfall saved | |
| Notes | Failed files reported `vipspng: libpng read error`; capture filenames and timings in the next run. |

**Baseline acceptance criteria:** The recorded waterfall shows whether only
no more than two `POST /admin/upload` requests are active at once, every
browser upload ID can be matched to a service-log entry, and the table is
complete before considering further upload concurrency.

### 2. Resolve image-decoding failures

- [ ] Record the exact names of files that return `vipspng: libpng read error`.
- [ ] Open each failed source PNG locally. If it opens, re-export it as PNG or
      JPEG and retry that copy; if it cannot open, replace the damaged source.
- [ ] Confirm retries of valid exports succeed through the one-file queue.
- [ ] Improve the UI later to show every failed filename and its decoder error.

**Why:** These failures occur after the upload reaches the server. Retrying the
same invalid PNG or increasing upload concurrency will not repair it.

### 3. Verify the bounded parallel one-file queue

- [x] Use a two-worker pool with `UPLOAD_CONCURRENCY = 2`.
- [x] Keep one photo per request and retain per-file failure collection.
- [ ] Compare the two-worker queue with the serial baseline on a 20-photo
      production test; retain it only if it improves total time without
      increasing failures.

**Why:** This improves throughput while preserving failure isolation. It is
bounded so it does not create an unlimited number of Cloudflare requests.

### 4. Optional: tune upload concurrency

- [ ] Keep `CHUNK_SIZE = 1`.
- [ ] Test two concurrent requests, then three only if two is stable and the
      connection and server are underutilized.
- [ ] Stop at the fastest reliable setting; do not use unlimited `Promise.all`.

**Recommended starting values:**

| Setting | Current / starting value |
| --- | --- |
| Files per request | 1 |
| Concurrent upload requests | 2 now; test 3 later |
| Concurrent processing jobs | 2-4 |

### 5. Show separate transfer and processing progress

- [ ] Show `Uploading 8 / 20` while browser-to-server transfer is happening.
- [ ] Show `Processing 8 / 20` once a server batch is queued.
- [ ] Include errors with the relevant filename and allow retrying failed
      files only.
- [ ] Do not label background image conversion as an active network upload.

**Why:** Image processing can take time even after all bytes arrive. Clear
states prevent a healthy background queue from looking frozen.

**Verify:** Throttle network in DevTools, then separately test fast network
with large images. The UI should accurately reveal which phase is slow.

### 6. Measure and tune image processing safely

- [x] Log each queued photo's input bytes, output dimensions, and total
      processing time; log the same timing for failures.
- [ ] Review those production logs during a 20-photo run before changing the
      processing-worker limit.
- [ ] Confirm the server has enough CPU and memory for the selected queue
      concurrency.
- [ ] Test queue concurrency at 2, then 3, then 4; stop increasing it when
      average processing time stops improving or memory pressure appears.
- [ ] Keep Sharp's single-decode pipeline and low WebP effort unless visual
      comparison shows a quality issue.
- [ ] Keep originals, display images, and thumbnails written asynchronously.

**Why:** More processing workers can make the machine slower when each image
decode already consumes substantial CPU and memory.

**Verify:** During a 20-photo upload, several jobs should make progress at
once, with no process restarts, out-of-memory events, or failed images.

### 7. Avoid unnecessary memory and disk work

- [ ] Keep incoming multipart uploads on disk rather than buffering the whole
      batch in server memory.
- [ ] Consider allowing Sharp to read a staged file path instead of first
      reading every complete file into a Node.js buffer.
- [ ] Ensure staged files are deleted after both successful and failed jobs.
- [ ] Track free disk space and alert if staging grows unexpectedly.

**Why:** Multiple full-resolution camera photos can use far more memory while
decoded than their file size suggests.

**Verify:** Upload a large batch and confirm memory stays stable after the
batch completes and the staging directory is empty.

### 8. Add resilience for real-world network failures

- [ ] Retry transient failures (network interruption, 429, and selected 5xx
      responses) with exponential backoff and a small retry limit.
- [ ] Do not retry validation failures or an over-size response.
- [ ] Preserve a client-side list of failed files so the user can retry just
      those files.
- [ ] Add an idempotency key per file or retain content-hash deduplication so
      retries do not create duplicates.
- [ ] Consider resumable multipart uploads if individual files are very large
      or connections are frequently interrupted.

**Verify:** Simulate offline mode during a batch. Successful files should
remain successful, and only interrupted files should require a retry.

### 9. Move large-scale transfers off the app server (future)

- [ ] Store originals in object storage.
- [ ] Have the server issue short-lived, scoped signed upload URLs.
- [ ] Upload directly from the browser to storage with the same bounded
      concurrency limit.
- [ ] Send only the completed object keys to the application to enqueue image
      processing.
- [ ] Use provider-supported multipart/resumable uploads for large originals.

**Why:** Direct uploads remove the app server and its request-time limit from
the path carrying image bytes. This is the right architecture for frequent or
large batch uploads.

**Verify:** A large batch continues uploading even when application workers
are busy processing earlier photos, and app-server bandwidth is no longer the
limiting factor.

## Acceptance test

- [ ] Upload 20 representative photos in one selection.
- [ ] No more than two upload HTTP requests run at once in the current
      configuration.
- [ ] The user can see distinct uploading and processing states.
- [ ] Every successful file appears exactly once.
- [ ] A single failed file does not stop the rest of the batch.
- [ ] PNG decoder failures name the affected file and are handled separately
      from network failures.
- [ ] If parallel one-file uploads are enabled later, total time is better than
      the serial baseline with no increase in failures.
- [ ] Repeat the test on a slower connection before deploying.

## Do not do

- Do not launch unlimited concurrent uploads.
- Do not restore multi-file multipart uploads merely to increase speed.
- Do not process images inside the HTTP upload request.
- Do not increase worker counts without measuring CPU, memory, and throughput.
- Do not report completion merely because the browser finished sending bytes;
  wait until processing has completed or clearly report it as still running.
