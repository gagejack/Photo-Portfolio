# Image Upload Efficiency To-Do

## Goal

Make selecting multiple photos feel responsive, transfer them reliably, and
process them without making the upload request wait for image conversion.

## Current behavior

- The browser groups files into chunks of 10.
- It sends one chunk and waits for its response before sending the next.
- The server stages a complete chunk to disk, then queues its photos for
  background processing.
- The background queue can process up to four photos at once.

The immediate bottleneck is the serial transfer loop: only one HTTP upload
request is active at a time. A slow first 10-photo request prevents the next
photos from starting.

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
the uploader. Use the same 20 representative camera photos for every later
comparison; record the exact file count, total bytes, and largest file.

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
   Step 2.

| Field | Baseline result |
| --- | --- |
| Test date/time | |
| Deployed revision | |
| Connection type | |
| Photo count | 20 |
| Total bytes | |
| Largest file | |
| Active upload requests (maximum) | |
| Browser transfer phase duration | |
| Server request duration(s) | |
| Selection-to-complete duration | |
| Successful / failed photos | |
| Network waterfall saved | |
| Notes | |

**Baseline acceptance criteria:** The recorded waterfall shows whether only
one `POST /admin/upload` is active at once, every browser upload ID can be
matched to a service-log entry, and the table is complete before Step 2 begins.

### 2. Add bounded parallel upload requests

- [ ] Replace the serial `for ... await sendChunk(...)` transfer loop in
      `public/js/upload.js` with a small worker pool.
- [ ] Start with `UPLOAD_CONCURRENCY = 2` active requests.
- [ ] Keep a fixed upper bound; do not use `Promise.all()` for an unrestricted
      number of chunks.
- [ ] Preserve per-chunk failures so one failed request does not abandon the
      rest of the selection.
- [ ] Keep collecting every returned `batchId` for the existing processing
      status polling.

**Why:** Two requests allow the browser to begin the next chunk while the
first is still transferring. An unrestricted number can overwhelm a slow
uplink, the server, or the hosting request limit.

**Verify:** Select 20 photos. DevTools should show no more than two active
upload requests, and the total transfer phase should improve over the
baseline.

### 3. Tune chunk size before raising concurrency

- [ ] Change `CHUNK_SIZE` from 10 to 3 or 5.
- [ ] Test 3 files × 2 requests first.
- [ ] Compare it with 5 files × 2 requests using the same test batch.
- [ ] Choose the fastest reliable setting, not automatically the most
      concurrent one.

**Why:** With smaller chunks, photos reach the server queue sooner and a
dropped request needs fewer photos to be retried. Smaller chunks also reduce
the chance a request reaches the hosting timeout.

**Recommended starting values:**

| Setting | Starting value |
| --- | --- |
| Files per chunk | 3 |
| Concurrent upload requests | 2 |
| Concurrent processing jobs | 2-4 |

### 4. Show separate transfer and processing progress

- [ ] Show `Uploading 8 / 20` while browser-to-server transfer is happening.
- [ ] Show `Processing 8 / 20` once a server batch is queued.
- [ ] Include errors with the relevant filename and allow retrying failed
      files only.
- [ ] Do not label background image conversion as an active network upload.

**Why:** Image processing can take time even after all bytes arrive. Clear
states prevent a healthy background queue from looking frozen.

**Verify:** Throttle network in DevTools, then separately test fast network
with large images. The UI should accurately reveal which phase is slow.

### 5. Measure and tune image processing safely

- [ ] Time `processUpload` per photo and log the result during a test run.
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

### 6. Avoid unnecessary memory and disk work

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

### 7. Add resilience for real-world network failures

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

### 8. Move large-scale transfers off the app server (future)

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
- [ ] At most two upload HTTP requests run at once.
- [ ] The user can see distinct uploading and processing states.
- [ ] Every successful file appears exactly once.
- [ ] A single failed file does not stop the rest of the batch.
- [ ] Total time is better than the baseline, with no increase in failures.
- [ ] Repeat the test on a slower connection before deploying.

## Do not do

- Do not launch unlimited concurrent uploads.
- Do not process images inside the HTTP upload request.
- Do not increase worker counts without measuring CPU, memory, and throughput.
- Do not report completion merely because the browser finished sending bytes;
  wait until processing has completed or clearly report it as still running.
