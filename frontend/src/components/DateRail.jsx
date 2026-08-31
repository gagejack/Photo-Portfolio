import { useEffect } from 'react';
import { buildRail } from '../layout.js';

export default function DateRail({ photos }) {
  const rail = buildRail(photos);

  useEffect(() => {
    const items = [...document.querySelectorAll('.r-item')];
    const months = items.filter(element => element.classList.contains('r-month'));
    const byId = new Map(
      [...document.querySelectorAll('.feed img[data-id]')]
        .map(image => [Number(image.dataset.id), image]),
    );
    const anchors = months
      .map(element => ({ element, image: byId.get(Number(element.dataset.photo)) }))
      .filter(anchor => anchor.image);
    if (!anchors.length) return undefined;

    const focusIndex = () => {
      const line = window.innerHeight * 0.28;
      let index = 0;
      anchors.forEach((anchor, candidate) => {
        if (anchor.image.getBoundingClientRect().top <= line) index = candidate;
      });
      const current = anchors[index];
      const next = anchors[index + 1];
      if (!next) return index;
      const start = current.image.getBoundingClientRect().top;
      const end = next.image.getBoundingClientRect().top;
      const fraction = end > start ? Math.min(1, Math.max(0, (line - start) / (end - start))) : 0;
      return index + fraction;
    };

    const paint = () => {
      const focus = focusIndex();
      for (const element of items) {
        const isYear = element.classList.contains('r-year');
        const index = isYear
          ? anchors.findIndex(anchor => anchor.element.dataset.key === element.dataset.key)
          : anchors.findIndex(anchor => anchor.element === element);
        if (index < 0) continue;
        const distance = Math.abs(index - focus);
        const strength = Math.max(0, 1 - distance / 4);
        const eased = strength * strength * (3 - 2 * strength);
        const baseSize = isYear ? 13 : 12;
        const scale = 1 + eased * (isYear ? 0.85 : 1.15);
        const grey = Math.round(215 - eased * 200);
        // Changing the actual font size keeps glyphs crisp. Transform scaling
        // can reuse a low-resolution text raster and make this rail pixelated.
        element.style.fontSize = `${(baseSize * scale).toFixed(2)}px`;
        element.style.color = `rgb(${grey},${grey},${grey})`;
        element.style.opacity = (0.45 + eased * 0.55).toFixed(3);
      }
    };

    let frame = null;
    const onScroll = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        paint();
        frame = null;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    paint();
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [photos]);

  function scrollTo(photoId) {
    document.querySelector(`.feed img[data-id="${photoId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <aside className="rail" aria-label="Photo dates">
      <div className="rail-inner">
        {rail.flatMap(group => {
          const first = group.months[0];
          return [
            <button key={`year-${group.year}`} className="r-item r-year" type="button" data-key={first?.key} onClick={() => scrollTo(first?.firstPhotoId)}>{group.year}</button>,
            ...group.months.map(month => (
              <button key={month.key} className="r-item r-month" type="button" data-key={month.key} data-photo={month.firstPhotoId} onClick={() => scrollTo(month.firstPhotoId)}>{month.label}</button>
            )),
          ];
        })}
      </div>
    </aside>
  );
}
