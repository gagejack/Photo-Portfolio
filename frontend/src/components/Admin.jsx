import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { photoBase } from '../layout.js';
import Flag from './Flag.jsx';
import Nav from './Nav.jsx';
import Upload from './Upload.jsx';

function flatten(nodes, output = [], depth = 0) {
  for (const node of nodes) {
    output.push({ ...node, depth });
    flatten(node.children, output, depth + 1);
  }
  return output;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function StorageBar({ storage }) {
  if (!storage) return null;
  const percentUsed = storage.totalBytes > 0
    ? Math.min(100, Math.max(0, (storage.usedBytes / storage.totalBytes) * 100))
    : 0;
  const label = `${formatBytes(storage.usedBytes)} used of ${formatBytes(storage.totalBytes)}; ${formatBytes(storage.freeBytes)} free`;

  return (
    <section className="storage-meter" aria-label={`Server storage: ${label}`}>
      <div className="storage-label"><span>Server storage</span><strong>{formatBytes(storage.freeBytes)} free</strong></div>
      <div
        className="storage-track"
        role="progressbar"
        aria-label="Server storage used"
        aria-valuemin="0"
        aria-valuemax={storage.totalBytes}
        aria-valuenow={storage.usedBytes}
      >
        <span className="storage-fill" style={{ width: `${percentUsed}%` }} />
      </div>
      <div className="storage-summary">{formatBytes(storage.usedBytes)} used of {formatBytes(storage.totalBytes)}</div>
    </section>
  );
}

function CategoryTree({
  nodes,
  depth = 0,
  activeId,
  openMenuId,
  onToggleMenu,
  onAddSubcategory,
  onSelectPhotos,
  onRename,
  onDelete,
}) {
  return nodes.map(node => (
    <div key={node.id}>
      <div className={`cat-row lvl${Math.min(depth, 3)} ${activeId === node.id ? 'active' : ''}`}>
        <div className="category-actions">
          <button
            className="category-menu-button"
            type="button"
            title={`Edit ${node.name}`}
            aria-label={`Edit ${node.name}`}
            aria-haspopup="menu"
            aria-expanded={openMenuId === node.id}
            onClick={() => onToggleMenu(node.id)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          {openMenuId === node.id && (
            <div className="category-menu" role="menu" aria-label={`Actions for ${node.name}`}>
              <button
                type="button"
                role="menuitem"
                disabled={node.children.length >= 3}
                title={node.children.length >= 3 ? 'A category can have at most 3 subcategories' : undefined}
                onClick={() => onAddSubcategory(node)}
              >
                Add subcategory
              </button>
              <button type="button" role="menuitem" onClick={() => onSelectPhotos(node)}>Select photos</button>
              <button type="button" role="menuitem" onClick={() => onRename(node)}>Rename</button>
              <button className="category-menu-delete" type="button" role="menuitem" onClick={() => onDelete(node)}>Delete</button>
            </div>
          )}
        </div>
        <Flag code={node.flag} />
        <a href={`/admin?c=${node.id}`}>{node.name}</a>
        <span className="count">{node.photoCount}</span>
      </div>
      {node.children.length > 0 && (
        <div className="kids">
          <CategoryTree
            nodes={node.children}
            depth={depth + 1}
            activeId={activeId}
            openMenuId={openMenuId}
            onToggleMenu={onToggleMenu}
            onAddSubcategory={onAddSubcategory}
            onSelectPhotos={onSelectPhotos}
            onRename={onRename}
            onDelete={onDelete}
          />
        </div>
      )}
    </div>
  ));
}

function PhotoCard({ photo, categories, onChanged, selecting, selected, onToggleSelection }) {
  const [caption, setCaption] = useState(photo.caption ?? '');
  const [takenAt, setTakenAt] = useState(photo.takenAt.slice(0, 10));
  const [categoryIds, setCategoryIds] = useState(photo.categoryIds.map(String));
  const [status, setStatus] = useState('');
  const base = photoBase(photo.filename);

  function toggleCategory(id) {
    setCategoryIds(current => (current.includes(id)
      ? current.filter(value => value !== id)
      : [...current, id]));
  }

  async function save(event) {
    event.preventDefault();
    setStatus('Saving…');
    try {
      await api(`/api/admin/photos/${photo.id}`, {
        method: 'PATCH',
        body: { caption, takenAt, categoryIds: categoryIds.map(Number) },
      });
      setStatus('Saved');
      window.setTimeout(() => setStatus(''), 1500);
      // The feed is ordered by taken_at, so a saved date moves the photo.
      // Without a refetch the grid keeps showing it in its old position.
      onChanged();
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function remove() {
    await api(`/api/admin/photos/${photo.id}`, { method: 'DELETE' });
    onChanged();
  }

  return (
    <article className="thumb">
      <img src={`/photos/thumb/${base}.webp`} alt={caption} loading="lazy" />
      {selecting && (
        <button
          className={`photo-select ${selected ? 'selected' : ''}`}
          type="button"
          aria-label={`${selected ? 'Deselect' : 'Select'} photo`}
          aria-pressed={selected}
          onClick={() => onToggleSelection(photo.id)}
        >
          {selected ? '✓' : '+'}
        </button>
      )}
      <button className="x" type="button" aria-label="Delete photo" onClick={remove}>&times;</button>
      <form className="meta" onSubmit={save}>
        <input aria-label="Date taken" type="date" value={takenAt} onChange={event => setTakenAt(event.target.value)} />
        <input aria-label="Caption" type="text" value={caption} onChange={event => setCaption(event.target.value)} placeholder="Caption" />
        <div className="cat-picker" role="group" aria-label="Categories">
          {categories.length ? categories.map(category => {
            const id = String(category.id);
            const member = categoryIds.includes(id);
            return (
              <div className={`cat-pick lvl${Math.min(category.depth, 3)} ${member ? 'in' : ''}`} key={category.id}>
                <span className="cat-pick-name" title={category.name}>{category.name}</span>
                <button
                  className="cat-pick-toggle"
                  type="button"
                  aria-pressed={member}
                  aria-label={`${member ? 'Remove from' : 'Add to'} ${category.name}`}
                  title={member ? 'Remove from category' : 'Add to category'}
                  onClick={() => toggleCategory(id)}
                >
                  {member ? '\u2212' : '+'}
                </button>
              </div>
            );
          }) : <p className="cat-pick-empty">No categories yet.</p>}
        </div>
        <button type="submit">Save</button>
        <span className="save-status" aria-live="polite">{status}</span>
      </form>
    </article>
  );
}

export default function Admin({ authenticated }) {
  const activeId = Number(new URLSearchParams(window.location.search).get('c')) || null;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [openMenuId, setOpenMenuId] = useState(null);
  const [selectionCategory, setSelectionCategory] = useState(null);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState([]);

  const load = useCallback(async () => {
    try {
      const query = activeId ? `?categoryId=${activeId}` : '';
      setData(await api(`/api/admin${query}`));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401) {
        window.location.replace('/admin/login');
        return;
      }
      setError(requestError.message);
    }
  }, [activeId]);

  useEffect(() => {
    if (authenticated === false) {
      window.location.replace('/admin/login');
      return;
    }
    load();
  }, [authenticated, load]);

  async function deleteCategory(category) {
    setOpenMenuId(null);
    if (!window.confirm(`Delete “${category.name}” and all nested categories?`)) return;
    try {
      await api(`/api/admin/categories/${category.id}`, { method: 'DELETE' });
      if (activeId === category.id) window.location.assign('/admin');
      else load();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function createCategory(name, parentId = null) {
    setOpenMenuId(null);
    try {
      await api('/api/admin/categories', { method: 'POST', body: { name, parentId } });
      await load();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  function addMainCategory() {
    createCategory(`Main Category #${data.categories.length + 1}`);
  }

  function addSubcategory(category) {
    createCategory(`New Sub Category #${category.children.length + 1}`, category.id);
  }

  async function renameCategory(category) {
    setOpenMenuId(null);
    const name = window.prompt('Rename category', category.name);
    if (name === null || name.trim() === '' || name.trim() === category.name) return;
    try {
      await api(`/api/admin/categories/${category.id}`, { method: 'PATCH', body: { name: name.trim() } });
      await load();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  function selectPhotos(category) {
    setOpenMenuId(null);
    setSelectionCategory(category);
    setSelectedPhotoIds([]);
  }

  function togglePhotoSelection(photoId) {
    setSelectedPhotoIds(current => current.includes(photoId)
      ? current.filter(id => id !== photoId)
      : [...current, photoId]);
  }

  async function finishSelection() {
    if (!selectionCategory) return;
    if (selectedPhotoIds.length === 0) {
      setSelectionCategory(null);
      return;
    }
    try {
      await api(`/api/admin/categories/${selectionCategory.id}/photos`, {
        method: 'POST',
        body: { photoIds: selectedPhotoIds },
      });
      setSelectionCategory(null);
      setSelectedPhotoIds([]);
      await load();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  const categories = data ? flatten(data.categories) : [];
  const active = categories.find(category => category.id === activeId);

  return (
    <>
      <Nav active="admin" authenticated />
      <div className="admin-cols">
        <aside className="side">
          {data && (
            <>
              <div className="category-header">
                <span>Categories</span>
                <div className="category-header-actions">
                  <a className={`show-all ${activeId ? '' : 'on'}`} href="/admin" title="Show all photos">All</a>
                  <button className="add-main-category" type="button" title="Add main category" aria-label="Add main category" onClick={addMainCategory}>+</button>
                </div>
              </div>
              <CategoryTree
                nodes={data.categories}
                activeId={activeId}
                openMenuId={openMenuId}
                onToggleMenu={id => setOpenMenuId(current => current === id ? null : id)}
                onAddSubcategory={addSubcategory}
                onSelectPhotos={selectPhotos}
                onRename={renameCategory}
                onDelete={deleteCategory}
              />
            </>
          )}
        </aside>
        <main className="admin-main">
          <div className="admin-heading">
            <div>
              <h1>{active?.name ?? 'All photos'}</h1>
              <div className="crumb">{data ? `${data.photos.length} photos` : 'Loading…'}</div>
            </div>
            {data && <StorageBar storage={data.storage} />}
          </div>
          {error && <p className="error-state">{error}</p>}
          {data && <Upload onComplete={load} />}
          {selectionCategory && (
            <div className="selection-toolbar" aria-live="polite">
              <span>Select photos to add to <strong>{selectionCategory.name}</strong>.</span>
              <button type="button" onClick={finishSelection}>Done</button>
            </div>
          )}
          {data && (
            <div className="thumbs">
              {data.photos.length
                ? data.photos.map(photo => (
                  <PhotoCard
                    key={photo.id}
                    photo={photo}
                    categories={categories}
                    onChanged={load}
                    selecting={Boolean(selectionCategory)}
                    selected={selectedPhotoIds.includes(photo.id)}
                    onToggleSelection={togglePhotoSelection}
                  />
                ))
                : <p className="dim">Nothing here yet.</p>}
            </div>
          )}
        </main>
      </div>
    </>
  );
}
