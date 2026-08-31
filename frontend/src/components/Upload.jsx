import { useRef, useState } from 'react';

// Each request contains exactly one photo, so a failed or timed-out multipart
// request cannot take the rest of the selected batch down with it. Two workers
// improve throughput without creating an unbounded number of active uploads.
const CHUNK_SIZE = 1;
const UPLOAD_CONCURRENCY = 2;
const POLL_MS = 700;
const STALL_TIMEOUT_MS = 10 * 60 * 1000;

function chunks(files) {
  const result = [];
  for (let index = 0; index < files.length; index += CHUNK_SIZE) {
    result.push(files.slice(index, index + CHUNK_SIZE));
  }
  return result;
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export default function Upload({ categoryId, onComplete }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [message, setMessage] = useState('');

  async function sendChunk(files) {
    const body = new FormData();
    files.forEach(file => body.append('photos', file));
    if (categoryId) body.append('categoryId', categoryId);
    const uploadId = crypto.randomUUID();
    const bytes = files.reduce((total, file) => total + file.size, 0);
    console.info('[upload] sending chunk', { uploadId, files: files.length, bytes });

    let response;
    try {
      response = await fetch('/admin/upload', {
        method: 'POST',
        headers: { 'X-Upload-Debug-Id': uploadId },
        body,
      });
    } catch (error) {
      console.error('[upload] no response received', { uploadId, files: files.length, bytes, online: navigator.onLine }, error);
      throw new Error(`network error: ${error.message} (debug ${uploadId})`);
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      console.error('[upload] server rejected chunk', { uploadId, status: response.status, detail: detail.error });
      throw new Error(`server returned ${response.status}${detail.error ? `: ${detail.error}` : ''} (debug ${uploadId})`);
    }
    const result = await response.json();
    console.info('[upload] chunk queued', { uploadId, batchId: result.batchId, total: result.total });
    return result;
  }

  async function status(batchId) {
    const response = await fetch(`/admin/upload/status/${batchId}`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    return response.json();
  }

  async function awaitProcessing(batchIds, onProgress) {
    const failures = [];
    const pending = new Set(batchIds);
    const progressByBatch = new Map(batchIds.map(id => [id, 0]));
    let lastProgress = 0;
    let lastChange = Date.now();
    while (pending.size) {
      await wait(POLL_MS);
      for (const batchId of [...pending]) {
        try {
          const current = await status(batchId);
          progressByBatch.set(batchId, current.done + current.failed.length);
          if (current.finished) {
            failures.push(...current.failed);
            pending.delete(batchId);
          }
        } catch (error) {
          console.warn('[upload] status poll failed', { batchId }, error);
        }
      }
      const done = [...progressByBatch.values()].reduce((sum, count) => sum + count, 0);
      onProgress(done);
      if (done !== lastProgress) {
        lastProgress = done;
        lastChange = Date.now();
      } else if (Date.now() - lastChange > STALL_TIMEOUT_MS) {
        throw new Error('processing stalled — check the server');
      }
    }
    return failures;
  }

  async function send(fileList) {
    const files = [...fileList];
    if (!files.length || uploading) return;
    setUploading(true);
    setMessage('');
    setProgress({ label: 'Uploading photos', done: 0, total: files.length });
    const batchIds = [];
    const failures = [];
    let transferred = 0;

    const batches = chunks(files);
    let nextBatch = 0;

    async function uploadWorker() {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch];
        nextBatch += 1;
        try {
          const result = await sendChunk(batch);
          batchIds.push(result.batchId);
        } catch (error) {
          batch.forEach(file => failures.push({ name: file.name, reason: error.message }));
        }
        transferred += batch.length;
        setProgress({ label: 'Uploading photos', done: transferred / 2, total: files.length });
      }
    }

    // This awaits a fixed number of workers, never one promise per file.
    await Promise.all(Array.from(
      { length: Math.min(UPLOAD_CONCURRENCY, batches.length) },
      uploadWorker,
    ));

    if (batchIds.length) {
      setProgress(current => ({ ...current, label: 'Processing photos' }));
      try {
        failures.push(...await awaitProcessing(batchIds, done => {
          setProgress({ label: 'Processing photos', done: files.length / 2 + done / 2, total: files.length });
        }));
      } catch (error) {
        setMessage(`Upload interrupted: ${error.message}`);
        setUploading(false);
        return;
      }
    }

    if (failures.length) {
      const succeeded = files.length - failures.length;
      setMessage(`${succeeded} uploaded, ${failures.length} failed: ${failures.map(file => `${file.name} (${file.reason})`).join(', ')}`);
    } else {
      setProgress({ label: 'Upload complete', done: files.length, total: files.length });
    }
    setUploading(false);
    onComplete();
  }

  return (
    <section className="upload-area">
      <label
        className={`drop ${over ? 'over' : ''} ${uploading ? 'disabled' : ''}`}
        onDragEnter={event => { event.preventDefault(); setOver(true); }}
        onDragOver={event => { event.preventDefault(); setOver(true); }}
        onDragLeave={event => { event.preventDefault(); setOver(false); }}
        onDrop={event => {
          event.preventDefault();
          setOver(false);
          send(event.dataTransfer.files);
        }}
      >
        {uploading ? 'Upload in progress…' : 'Drop photos here, or click to choose files'}
        <input ref={input} type="file" multiple accept="image/*" hidden disabled={uploading} onChange={event => {
          const selected = [...event.target.files];
          event.target.value = '';
          send(selected);
        }} />
      </label>
      <div className="progress" aria-live="polite">
        {progress && (
          <div className="up-row">
            <span className="up-label">{progress.label}</span>
            <span className="up-track"><span className="up-fill" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></span>
            <span className="up-count">{Math.round(progress.done)} / {progress.total}</span>
          </div>
        )}
        {message && <p className="upload-message">{message}</p>}
      </div>
    </section>
  );
}
