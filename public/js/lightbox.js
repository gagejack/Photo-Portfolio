// public/js/lightbox.js
(function () {
  const box = document.getElementById('lightbox');
  if (!box) return;

  const img = box.querySelector('.lb-img');
  const photos = [...document.querySelectorAll('.feed img[data-full]')];
  let index = -1;

  function show(i) {
    if (i < 0 || i >= photos.length) return;
    index = i;
    img.src = photos[i].dataset.full;
    img.alt = photos[i].alt || '';
    box.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function close() {
    box.hidden = true;
    img.src = '';
    document.body.style.overflow = '';
    if (index >= 0) photos[index].focus?.();
  }

  photos.forEach((p, i) => p.addEventListener('click', () => show(i)));

  box.querySelector('.lb-close').addEventListener('click', close);
  box.querySelector('.lb-prev').addEventListener('click', e => { e.stopPropagation(); show(index - 1); });
  box.querySelector('.lb-next').addEventListener('click', e => { e.stopPropagation(); show(index + 1); });

  // A click on the backdrop closes; a click on the image itself does not.
  box.addEventListener('click', e => { if (e.target === box) close(); });

  document.addEventListener('keydown', e => {
    if (box.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
  });
})();
