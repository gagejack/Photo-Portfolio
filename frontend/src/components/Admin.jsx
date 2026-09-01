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

const FAVORITES_SLUG = 'favorites';

function Star({ filled }) {
  return (
    <svg className="star-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 2.6l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.44 6.19 20.5 7.3 14.03 2.6 9.45l6.5-.95L12 2.6z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CategoryTree({
  nodes,
  depth = 0,
  parentId = null,
  activeId,
  openMenuId,
  onToggleMenu,
  onAddSubcategory,
  onSelectPhotos,
  onRename,
  onDelete,
  drag,
}) {
  return nodes.map((node, index) => (
    <div key={node.id}>
      <div
        className={[
          `cat-row lvl${Math.min(depth, 3)}`,
          activeId === node.id ? 'active' : '',
          drag.draggingId === node.id ? 'dragging' : '',
          drag.overId === node.id ? `drop-${drag.overSide}` : '',
        ].filter(Boolean).join(' ')}
        onDragOver={event => drag.onDragOver(event, node, parentId, index)}
        onDrop={event => drag.onDrop(event, parentId)}
      >
        <div className="category-actions">
          <button
            className="category-menu-button"
            type="button"
            title={`Reorder or edit ${node.name}`}
            aria-label={`Reorder or edit ${node.name}`}
            aria-haspopup="menu"
            aria-expanded={openMenuId === node.id}
            draggable
            onDragStart={event => drag.onDragStart(event, node, parentId)}
            onDragEnd={drag.onDragEnd}
            onClick={() => onToggleMenu(node.id)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          {openMenuId === node.id && (
            <div className="category-menu" role="menu" aria-label={`Actions for ${node.name}`}>
              {node.slug === FAVORITES_SLUG ? (
                <button type="button" role="menuitem" onClick={() => onSelectPhotos(node)}>Select photos</button>
              ) : (
                <>
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
                </>
              )}
            </div>
          )}
        </div>
        {node.slug === FAVORITES_SLUG ? (
          <a className="cat-favorites" href={`/admin?c=${node.id}`} title="Favorites" aria-label="Favorites">
            <Star filled />
          </a>
        ) : (
          <>
            <Flag code={node.flag} />
            <a href={`/admin?c=${node.id}`}>{node.name}</a>
          </>
        )}
        <span className="count">{node.photoCount}</span>
      </div>
      {node.children.length > 0 && (
        <div className="kids">
          <CategoryTree
            nodes={node.children}
            depth={depth + 1}
            parentId={node.id}
            activeId={activeId}
            openMenuId={openMenuId}
            onToggleMenu={onToggleMenu}
            onAddSubcategory={onAddSubcategory}
            onSelectPhotos={onSelectPhotos}
            onRename={onRename}
            onDelete={onDelete}
            drag={drag}
          />
        </div>
      )}
    </div>
  ));
}

// The stored form of a photo's editable fields. Draft state is compared
// against this to decide which photos are dirty and need saving.
function baseDraft(photo) {
  return {
    caption: photo.caption ?? '',
    takenAt: photo.takenAt.slice(0, 10),
    categoryIds: photo.categoryIds.map(String),
  };
}

function isDirty(draft, photo) {
  const stored = baseDraft(photo);
  return draft.caption !== stored.caption
    || draft.takenAt !== stored.takenAt
    || draft.categoryIds.length !== stored.categoryIds.length
    || draft.categoryIds.some(id => !stored.categoryIds.includes(id));
}

function PhotoCard({ photo, categories, draft, dirty, favoritesId, onEdit, onChanged, selecting, selected, onToggleSelection }) {
  const { caption, takenAt, categoryIds } = draft;
  const base = photoBase(photo.filename);
  const favorited = favoritesId !== null && categoryIds.includes(String(favoritesId));

  function toggleCategory(id) {
    onEdit(photo.id, {
      categoryIds: categoryIds.includes(id)
        ? categoryIds.filter(value => value !== id)
        : [...categoryIds, id],
    });
  }

  async function remove() {
    await api(`/api/admin/photos/${photo.id}`, { method: 'DELETE' });
    onChanged();
  }

  return (
    <article className={`thumb ${dirty ? 'edited' : ''}`}>
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
      {favoritesId !== null && (
        <button
          className={`photo-star ${favorited ? 'on' : ''}`}
          type="button"
          aria-pressed={favorited}
          aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
          title={favorited ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => toggleCategory(String(favoritesId))}
        >
          <Star filled={favorited} />
        </button>
      )}
      <button className="x" type="button" aria-label="Delete photo" onClick={remove}>&times;</button>
      <div className="meta">
        <input aria-label="Date taken" type="date" value={takenAt} onChange={event => onEdit(photo.id, { takenAt: event.target.value })} />
        <input aria-label="Caption" type="text" value={caption} onChange={event => onEdit(photo.id, { caption: event.target.value })} placeholder="Caption" />
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
      </div>
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
  const [drafts, setDrafts] = useState({});
  const [dragState, setDragState] = useState({ id: null, parentId: null, overId: null, overSide: 'before' });
  const [saveStatus, setSaveStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const query = activeId ? `?categoryId=${activeId}` : '';
      const next = await api(`/api/admin${query}`);
      setData(next);
      // Drafts are re-seeded from what the server just returned, so a
      // completed save leaves nothing marked as pending.
      setDrafts(Object.fromEntries(next.photos.map(photo => [photo.id, baseDraft(photo)])));
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
  const favoritesId = categories.find(category => category.slug === FAVORITES_SLUG)?.id ?? null;
  const dirtyPhotos = (data?.photos ?? []).filter(
    photo => drafts[photo.id] && isDirty(drafts[photo.id], photo),
  );

  // Reordering is sibling-only: a drop onto a different parent's row is
  // ignored rather than reparenting, so dragging can never restructure the
  // tree by accident. Reparenting stays an explicit action.
  function onDragStart(event, node, parentId) {
    setOpenMenuId(null);
    event.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag unless some data is set.
    event.dataTransfer.setData('text/plain', String(node.id));
    setDragState({ id: node.id, parentId, overId: null, overSide: 'before' });
  }

  function onDragOver(event, node, parentId, index) {
    if (dragState.id === null || parentId !== dragState.parentId || node.id === dragState.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const bounds = event.currentTarget.getBoundingClientRect();
    const side = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
    setDragState(current => (current.overId === node.id && current.overSide === side
      ? current
      : { ...current, overId: node.id, overSide: side }));
    void index;
  }

  function onDragEnd() {
    setDragState({ id: null, parentId: null, overId: null, overSide: 'before' });
  }

  async function onDrop(event, parentId) {
    event.preventDefault();
    const { id, overId, overSide } = dragState;
    onDragEnd();
    if (id === null || overId === null || parentId !== dragState.parentId) return;

    const siblings = parentId === null
      ? (data?.categories ?? [])
      : (flatten(data?.categories ?? []).find(node => node.id === parentId)?.children ?? []);
    const order = siblings.map(node => node.id).filter(nodeId => nodeId !== id);
    const target = order.indexOf(overId);
    if (target === -1) return;
    order.splice(overSide === 'before' ? target : target + 1, 0, id);

    try {
      await api('/api/admin/categories/reorder', { method: 'POST', body: { parentId, orderedIds: order } });
      await load();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  function editPhoto(id, patch) {
    setSaveStatus('');
    setDrafts(current => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  function discardChanges() {
    if (!data) return;
    setSaveStatus('');
    setDrafts(Object.fromEntries(data.photos.map(photo => [photo.id, baseDraft(photo)])));
  }

  async function saveChanges() {
    if (!dirtyPhotos.length) return;
    setSaving(true);
    setSaveStatus('');
    const failed = [];
    for (const photo of dirtyPhotos) {
      const draft = drafts[photo.id];
      try {
        await api(`/api/admin/photos/${photo.id}`, {
          method: 'PATCH',
          body: {
            caption: draft.caption,
            takenAt: draft.takenAt,
            categoryIds: draft.categoryIds.map(Number),
          },
        });
      } catch (requestError) {
        failed.push({ photo, message: requestError.message });
      }
    }
    setSaving(false);
    // load() re-seeds every draft, which would silently drop edits that never
    // reached the server. Only refetch once the whole batch is through.
    if (!failed.length) {
      await load();
      return;
    }
    setSaveStatus(failed.length === dirtyPhotos.length
      ? `Nothing saved. ${failed[0].message}`
      : `Saved ${dirtyPhotos.length - failed.length} of ${dirtyPhotos.length}. ${failed[0].message}`);
  }

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
                drag={{
                  draggingId: dragState.id,
                  overId: dragState.overId,
                  overSide: dragState.overSide,
                  onDragStart, onDragOver, onDragEnd, onDrop,
                }}
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
            <div className="admin-title">
              <h1>{active?.name ?? 'All photos'}</h1>
              <div className="crumb">
                {data ? `${data.photos.length} photos` : 'Loading…'}
                {dirtyPhotos.length > 0 && <span className="crumb-pending"> · {dirtyPhotos.length} edited</span>}
              </div>
            </div>
            {dirtyPhotos.length > 0 && (
              <div className="save-bar">
                <button className="discard" type="button" onClick={discardChanges} disabled={saving}>Discard</button>
                <button className="save-changes" type="button" onClick={saveChanges} disabled={saving}>
                  {saving ? 'Saving…' : `Save ${dirtyPhotos.length} photo${dirtyPhotos.length === 1 ? '' : 's'}`}
                </button>
              </div>
            )}
            {data && <StorageBar storage={data.storage} />}
          </div>
          {error && <p className="error-state">{error}</p>}
          {saveStatus && <p className="error-state" role="alert">{saveStatus}</p>}
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
                    draft={drafts[photo.id] ?? baseDraft(photo)}
                    dirty={Boolean(drafts[photo.id]) && isDirty(drafts[photo.id], photo)}
                    favoritesId={favoritesId}
                    onEdit={editPhoto}
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
