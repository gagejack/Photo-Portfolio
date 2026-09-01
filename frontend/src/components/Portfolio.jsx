import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { justify, photoBase } from '../layout.js';
import DateRail from './DateRail.jsx';
import Lightbox from './Lightbox.jsx';
import Nav from './Nav.jsx';

const MAX_WIDTH = 1600;
const GUTTER = 10;

// Row height shrinks on narrow screens so phones get 1-2 photos per row
// instead of a row of slivers packed to a desktop-width container.
function targetHeight(width) {
  if (width < 500) return Math.round(width * 0.72);
  if (width < 900) return Math.round(width * 0.42);
  return 320;
}

export default function Portfolio({ slug, authenticated }) {
  const feedRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState(null);
  const [lightbox, setLightbox] = useState(-1);
  const [colorSorted, setColorSorted] = useState(
    () => new URLSearchParams(window.location.search).get('sort') === 'color',
  );

  useEffect(() => {
    setFeed(null);
    setError(null);
    const params = new URLSearchParams();
    if (slug) params.set('category', slug);
    if (colorSorted) params.set('sort', 'color');
    const query = params.size ? `?${params}` : '';
    api(`/api/feed${query}`).then(setFeed).catch(setError);
  }, [slug, colorSorted]);

  useEffect(() => {
    const node = feedRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [feed]);

  const rows = useMemo(
    () => (containerWidth
      ? justify(feed?.photos ?? [], {
        containerWidth: Math.min(containerWidth, MAX_WIDTH),
        targetHeight: targetHeight(containerWidth),
        gutter: GUTTER,
      })
      : []),
    [feed, containerWidth],
  );
  const closeLightbox = useCallback(() => setLightbox(-1), []);
  const changeLightbox = useCallback(index => setLightbox(index), []);

  function toggleColorSort() {
    const next = !colorSorted;
    const path = slug ? `/c/${encodeURIComponent(slug)}` : '/';
    window.history.replaceState({}, '', next ? `${path}?sort=color` : path);
    setColorSorted(next);
  }

  return (
    <>
      <Nav active="portfolio" authenticated={authenticated} />
      {feed && (
        <div className="filters" aria-label="Portfolio categories">
          <button
            className={`color-sort ${colorSorted ? 'on' : ''}`}
            type="button"
            title="Sort by dominant color"
            aria-label="Sort by dominant color"
            aria-pressed={colorSorted}
            onClick={toggleColorSort}
          >
            <span className="rgb-icon" aria-hidden="true" />
          </button>
          <a className={`f ${slug ? '' : 'on'}`} href={colorSorted ? '/?sort=color' : '/'}>All</a>
          {feed.categories.map(category => (
            <a key={category.id} className={`f ${slug === category.slug ? 'on' : ''}`} href={`/c/${encodeURIComponent(category.slug)}${colorSorted ? '?sort=color' : ''}`}>{category.name}</a>
          ))}
        </div>
      )}
      <div className="stage">
        {error ? (
          <main className="feed"><p className="error-state">{error.status === 404 ? 'Category not found.' : 'Could not load photos.'}</p></main>
        ) : !feed ? (
          <main className="feed"><p className="empty">Loading photos…</p></main>
        ) : (
          <>
            <main className="feed" ref={feedRef}>
              {rows.length ? rows.map((row, rowIndex) => (
                <div className="photo-row" style={{ height: row.height }} key={`${rowIndex}-${row.items[0].photo.id}`}>
                  {row.items.map(item => {
                    const base = photoBase(item.photo.filename);
                    const index = feed.photos.findIndex(photo => photo.id === item.photo.id);
                    return (
                      <button className="cell" type="button" style={{ width: item.width }} key={item.photo.id} onClick={() => setLightbox(index)}>
                        <img
                          src={`/photos/thumb/${base}.webp`}
                          srcSet={`/photos/thumb/${base}.webp 800w, /photos/display/${base}.webp 2560w`}
                          sizes={`${Math.min(Math.ceil(item.width), 800)}px`}
                          width={item.width}
                          height={row.height}
                          loading="lazy"
                          alt={item.photo.caption ?? ''}
                          data-id={item.photo.id}
                        />
                      </button>
                    );
                  })}
                </div>
              )) : <p className="empty">No photos yet.</p>}
            </main>
            {!colorSorted && <DateRail photos={feed.photos} />}
          </>
        )}
      </div>
      {feed && <Lightbox photos={feed.photos} index={lightbox} onChange={changeLightbox} onClose={closeLightbox} />}
    </>
  );
}
