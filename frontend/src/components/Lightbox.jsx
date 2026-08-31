import { useEffect } from 'react';
import { photoBase } from '../layout.js';

export default function Lightbox({ photos, index, onChange, onClose }) {
  useEffect(() => {
    if (index < 0) return undefined;
    document.body.style.overflow = 'hidden';
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && index > 0) onChange(index - 1);
      if (event.key === 'ArrowRight' && index < photos.length - 1) onChange(index + 1);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [index, onChange, onClose, photos.length]);

  if (index < 0) return null;
  const photo = photos[index];
  const src = `/photos/display/${photoBase(photo.filename)}.webp`;

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Photo viewer" onClick={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <button className="lb-close" type="button" aria-label="Close" onClick={onClose}>&times;</button>
      <button className="lb-prev" type="button" aria-label="Previous" disabled={index === 0} onClick={() => onChange(index - 1)}>&#8249;</button>
      <img className="lb-img" src={src} alt={photo.caption ?? ''} />
      <button className="lb-next" type="button" aria-label="Next" disabled={index === photos.length - 1} onClick={() => onChange(index + 1)}>&#8250;</button>
    </div>
  );
}
