(function () {
  const form = document.getElementById('uploader');
  if (!form) return;

  const input = form.querySelector('input[type=file]');
  const drop = form.querySelector('.drop');
  const progress = document.getElementById('progress');

  // Cloudflare caps a single request at 100s. Large batches of full-size
  // camera JPEGs resize slower than that server-side, so upload a few at a
  // time in separate requests rather than one all-or-nothing POST.
  const CHUNK_SIZE = 3;

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

    const res = await fetch('/admin/upload', { method: 'POST', body: data });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    return res.json();
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
        this.count.textContent = `${done} / ${total}`;
      },
    };
  }

  async function send(files) {
    if (!files.length) return;

    const batches = chunk(files, CHUNK_SIZE);
    let done = 0;
    const allFailed = [];
    const bar = showBar(files.length);

    for (const batch of batches) {
      try {
        const result = await sendChunk(batch);
        allFailed.push(...result.failed);
      } catch (err) {
        for (const f of batch) allFailed.push({ name: f.name, reason: err.message });
      }
      done += batch.length;
      bar.update(done);
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

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => send([...input.files]));

  ['dragenter', 'dragover'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); })
  );
  drop.addEventListener('drop', e => send([...e.dataTransfer.files]));
})();
