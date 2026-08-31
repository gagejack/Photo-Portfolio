(function () {
  const form = document.getElementById('uploader');
  if (!form) return;

  const input = form.querySelector('input[type=file]');
  const drop = form.querySelector('.drop');
  const progress = document.getElementById('progress');

  // Processing no longer happens inside the request, so a chunk only has to
  // survive its own transfer time against Cloudflare's 100s cap. Chunking is
  // kept so a dropped connection costs ten photos rather than the whole batch.
  const CHUNK_SIZE = 10;

  const POLL_MS = 700;
  // If nothing advances for this long, something is wrong server-side and the
  // poll should stop rather than spin forever.
  const STALL_TIMEOUT_MS = 10 * 60 * 1000;

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  async function sendChunk(files) {
    const data = new FormData();
    for (const f of files) data.append('photos', f);

    const params = new URLSearchParams(location.search);
    if (params.get('c')) data.append('categoryId', params.get('c'));

    const uploadId = crypto.randomUUID();
    const bytes = files.reduce((total, file) => total + file.size, 0);
    console.info('[upload] sending chunk', { uploadId, files: files.length, bytes });

    let res;
    try {
      res = await fetch('/admin/upload', {
        method: 'POST',
        headers: { 'X-Upload-Debug-Id': uploadId },
        body: data,
      });
    } catch (err) {
      console.error('[upload] no response received', {
        uploadId,
        files: files.length,
        bytes,
        online: navigator.onLine,
      }, err);
      throw new Error(`network error: ${err.message} (debug ${uploadId})`);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body.error ?? '';
      } catch {
        // The status code and request ID are still enough to correlate logs.
      }
      console.error('[upload] server rejected chunk', { uploadId, status: res.status, detail });
      throw new Error(`server returned ${res.status}${detail ? `: ${detail}` : ''} (debug ${uploadId})`);
    }

    const result = await res.json();
    console.info('[upload] chunk queued', { uploadId, batchId: result.batchId, total: result.total });
    return result;
  }

  function showBar(total) {
    progress.textContent = '';
    const row = document.createElement('div');
    row.className = 'up-row';
    row.innerHTML =
      '<span class="up-label">Uploading photos</span>' +
      '<span class="up-track"><span class="up-fill"></span></span>' +
      `<span class="up-count">0 / ${total}</span>`;
    progress.appendChild(row);
    return {
      row,
      label: row.querySelector('.up-label'),
      fill: row.querySelector('.up-fill'),
      count: row.querySelector('.up-count'),
      update(done) {
        this.fill.style.width = `${Math.round((done / total) * 100)}%`;
        this.count.textContent = `${Math.round(done)} / ${total}`;
      },
    };
  }

  async function fetchStatus(batchId) {
    try {
      const res = await fetch(`/admin/upload/status/${batchId}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    } catch (err) {
      console.warn('[upload] status poll failed', { batchId }, err);
      throw err;
    }
  }

  // Poll every batch until all of them report finished, reporting combined
  // progress. Returns the failures collected across all of them.
  async function awaitProcessing(batchIds, onProgress) {
    const failed = [];
    const pending = new Set(batchIds);
    // Keep each batch's last observed count after it finishes. Otherwise,
    // removing a finished batch from `pending` would make the combined bar
    // move backwards while the remaining batches are still processing.
    const progressByBatch = new Map(batchIds.map(batchId => [batchId, 0]));
    let lastProgress = 0;
    let lastChange = Date.now();

    while (pending.size > 0) {
      await new Promise(r => setTimeout(r, POLL_MS));

      for (const batchId of [...pending]) {
        let status;
        try {
          status = await fetchStatus(batchId);
        } catch {
          // A transient failure should not abandon the batch; the stall
          // timeout below is what gives up.
          continue;
        }
        progressByBatch.set(batchId, status.done + status.failed.length);
        if (status.finished) {
          failed.push(...status.failed);
          pending.delete(batchId);
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
    return failed;
  }

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

  // No click handler here: `input` lives inside <label class="drop">, so the
  // label forwards the click natively. Calling input.click() too opened the
  // picker twice and the second dialog cancelled the first selection.
  input.addEventListener('change', () => {
    const files = [...input.files];
    // Reset so picking the same file again still fires `change`.
    input.value = '';
    send(files);
  });

  ['dragenter', 'dragover'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); })
  );
  drop.addEventListener('drop', e => send([...e.dataTransfer.files]));
})();
