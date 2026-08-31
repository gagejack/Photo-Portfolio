import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { justify, photoBase } from '../layout.js';
import DateRail from './DateRail.jsx';
import Lightbox from './Lightbox.jsx';
import Nav from './Nav.jsx';

const LAYOUT = { containerWidth: 1600, targetHeight: 320, gutter: 10 };

export default function Portfolio({ slug, authenticated }) {
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState(null);
  const [lightbox, setLightbox] = useState(-1);

  useEffect(() => {
    setFeed(null);
    setError(null);
    const query = slug ? `?category=${encodeURIComponent(slug)}` : '';
    api(`/api/feed${query}`).then(setFeed).catch(setError);
  }, [slug]);

  const rows = useMemo(
    () => justify(feed?.photos ?? [], LAYOUT),
    [feed],
  );
  const closeLightbox = useCallback(() => setLightbox(-1), []);
  const changeLightbox = useCallback(index => setLightbox(index), []);

  return (
    <>
      <Nav active="portfolio" authenticated={authenticated} />
      {feed && (
        <div className="filters" aria-label="Portfolio categories">
          <a className={`f ${slug ? '' : 'on'}`} href="/">All</a>
          {feed.categories.map(category => (
            <a key={category.id} className={`f ${slug === category.slug ? 'on' : ''}`} href={`/c/${encodeURIComponent(category.slug)}`}>{category.name}</a>
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
            <main className="feed">
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
                          sizes={`${Math.ceil(item.width)}px`}
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
            <DateRail photos={feed.photos} />
          </>
        )}
      </div>
      {feed && <Lightbox photos={feed.photos} index={lightbox} onChange={changeLightbox} onClose={closeLightbox} />}
    </>
  );
}
