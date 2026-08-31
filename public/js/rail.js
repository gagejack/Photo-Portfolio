// public/js/rail.js
(function () {
  const items = [...document.querySelectorAll('.r-item')];
  const months = items.filter(el => el.classList.contains('r-month'));
  if (months.length === 0) return;

  const photos = [...document.querySelectorAll('.feed img[data-id]')];
  const byId = new Map(photos.map(img => [Number(img.dataset.id), img]));

  // Anchor each month to the first photo of that period.
  const anchors = months
    .map(el => ({ el, img: byId.get(Number(el.dataset.photo)) }))
    .filter(a => a.img);

  function focusIndex() {
    const line = window.innerHeight * 0.28;
    let idx = 0;
    anchors.forEach((a, i) => {
      if (a.img.getBoundingClientRect().top <= line) idx = i;
    });

    const cur = anchors[idx];
    const nxt = anchors[idx + 1];
    if (!nxt) return idx;

    const a = cur.img.getBoundingClientRect().top;
    const b = nxt.img.getBoundingClientRect().top;
    const frac = b > a ? Math.min(1, Math.max(0, (line - a) / (b - a))) : 0;
    return idx + frac;
  }

  function paint() {
    const f = focusIndex();

    items.forEach(el => {
      // Years take the distance of their nearest month.
      const isYear = el.classList.contains('r-year');
      const i = isYear
        ? anchors.findIndex(a => a.el.dataset.key === el.dataset.key)
        : anchors.findIndex(a => a.el === el);
      if (i < 0) return;

      const d = Math.abs(i - f);
      const t = Math.max(0, 1 - d / 4);
      const e = t * t * (3 - 2 * t);              // smoothstep
      const scale = 1 + e * (isYear ? 0.85 : 1.15);
      const grey = Math.round(215 - e * 200);

      el.style.transform = `scale(${scale.toFixed(3)})`;
      el.style.color = `rgb(${grey},${grey},${grey})`;
      el.style.opacity = (0.45 + e * 0.55).toFixed(3);
    });
  }

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { paint(); ticking = false; });
  }, { passive: true });

  items.forEach(el => {
    el.addEventListener('click', () => {
      const a = anchors.find(x => x.el.dataset.key === el.dataset.key);
      if (a) a.img.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  paint();
})();
