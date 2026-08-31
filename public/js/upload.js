(function () {
  const form = document.getElementById('uploader');
  if (!form) return;

  const input = form.querySelector('input[type=file]');
  const drop = form.querySelector('.drop');
  const progress = document.getElementById('progress');

  async function send(files) {
    if (!files.length) return;
    const data = new FormData();
    for (const f of files) data.append('photos', f);

    const params = new URLSearchParams(location.search);
    if (params.get('c')) data.append('categoryId', params.get('c'));

    progress.textContent = `Uploading ${files.length} photo${files.length > 1 ? 's' : ''}…`;

    try {
      const res = await fetch('/admin/upload', { method: 'POST', body: data });
      const result = await res.json();
      if (result.failed.length) {
        progress.textContent =
          `${result.uploaded.length} uploaded, ${result.failed.length} failed: ` +
          result.failed.map(f => `${f.name} (${f.reason})`).join(', ');
        setTimeout(() => location.reload(), 4000);
      } else {
        location.reload();
      }
    } catch (err) {
      progress.textContent = `Upload failed: ${err.message}`;
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
