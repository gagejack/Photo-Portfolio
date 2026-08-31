import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { photoBase } from '../layout.js';
import Flag from './Flag.jsx';
import Nav from './Nav.jsx';
import Upload from './Upload.jsx';

function flatten(nodes, output = []) {
  for (const node of nodes) {
    output.push(node);
    flatten(node.children, output);
  }
  return output;
}

function CategoryTree({ nodes, depth = 0, activeId, onDelete }) {
  return nodes.map(node => (
    <div key={node.id}>
      <div className={`cat-row lvl${Math.min(depth, 3)} ${activeId === node.id ? 'active' : ''}`}>
        <span className="arrow">{node.children.length ? '▸' : ''}</span>
        <Flag code={node.flag} />
        <a href={`/admin?c=${node.id}`}>{node.name}</a>
        <span className="count">{node.photoCount}</span>
        <button className="category-delete" type="button" title="Delete" aria-label={`Delete ${node.name}`} onClick={() => onDelete(node)}>&times;</button>
      </div>
      {node.children.length > 0 && <div className="kids"><CategoryTree nodes={node.children} depth={depth + 1} activeId={activeId} onDelete={onDelete} /></div>}
    </div>
  ));
}

function AddCategory({ categories, onCreated }) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [flag, setFlag] = useState('');
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/admin/categories', {
        method: 'POST',
        body: { name, parentId: parentId || null, flag: flag || null },
      });
      setName('');
      setFlag('');
      onCreated();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  return (
    <form className="add-cat" onSubmit={submit}>
      <input value={name} onChange={event => setName(event.target.value)} placeholder="New category" required />
      <select value={parentId} onChange={event => setParentId(event.target.value)}>
        <option value="">Top level</option>
        {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
      <input value={flag} onChange={event => setFlag(event.target.value)} placeholder="Flag (jp)" maxLength="2" />
      <button type="submit">Add</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function PhotoCard({ photo, categories, onChanged }) {
  const [caption, setCaption] = useState(photo.caption ?? '');
  const [takenAt, setTakenAt] = useState(photo.takenAt.slice(0, 10));
  const [categoryIds, setCategoryIds] = useState(photo.categoryIds.map(String));
  const [status, setStatus] = useState('');
  const base = photoBase(photo.filename);

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
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this photo permanently?')) return;
    await api(`/api/admin/photos/${photo.id}`, { method: 'DELETE' });
    onChanged();
  }

  return (
    <article className="thumb">
      <img src={`/photos/thumb/${base}.webp`} alt={caption} loading="lazy" />
      <button className="x" type="button" aria-label="Delete photo" onClick={remove}>&times;</button>
      <form className="meta" onSubmit={save}>
        <input aria-label="Date taken" type="date" value={takenAt} onChange={event => setTakenAt(event.target.value)} />
        <input aria-label="Caption" type="text" value={caption} onChange={event => setCaption(event.target.value)} placeholder="Caption" />
        <select aria-label="Categories" multiple size="3" value={categoryIds} onChange={event => setCategoryIds([...event.target.selectedOptions].map(option => option.value))}>
          {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
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
    if (!window.confirm(`Delete “${category.name}” and all nested categories?`)) return;
    await api(`/api/admin/categories/${category.id}`, { method: 'DELETE' });
    if (activeId === category.id) window.location.assign('/admin');
    else load();
  }

  const categories = data ? flatten(data.categories) : [];
  const active = categories.find(category => category.id === activeId);

  return (
    <>
      <Nav active="admin" authenticated />
      <div className="admin-cols">
        <aside className="side">
          {data && <CategoryTree nodes={data.categories} activeId={activeId} onDelete={deleteCategory} />}
          {data && <AddCategory categories={categories} onCreated={load} />}
        </aside>
        <main className="admin-main">
          <h1>{active?.name ?? 'All photos'}</h1>
          <div className="crumb">{data ? `${data.photos.length} photos` : 'Loading…'}</div>
          {error && <p className="error-state">{error}</p>}
          {data && <Upload categoryId={activeId} onComplete={load} />}
          {data && (
            <div className="thumbs">
              {data.photos.length
                ? data.photos.map(photo => <PhotoCard key={photo.id} photo={photo} categories={categories} onChanged={load} />)
                : <p className="dim">Nothing here yet.</p>}
            </div>
          )}
        </main>
      </div>
    </>
  );
}
