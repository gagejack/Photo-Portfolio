import express from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { requireAuth } from './auth.js';
import { processUpload, removePhotoFiles, stagingDir } from '../images/pipeline.js';
import { createQueue } from '../images/queue.js';
import {
  insertPhoto, listPhotos, getPhoto, deletePhoto, setPhotoCategories, updatePhoto
} from '../db/photos.js';
import {
  listTree, createCategory, deleteCategory
} from '../db/categories.js';
import { layoutPage, escapeHtml } from '../web/render.js';
import { flagSvg } from '../web/flags.js';

const slugify = s => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function renderTree(nodes, depth = 0) {
  return nodes.map(n => `
    <div class="cat-row lvl${depth}" data-id="${n.id}">
      <span class="arrow">${n.children.length ? '▸' : ''}</span>
      ${n.flag ? flagSvg(n.flag) : '<span class="flagpad"></span>'}
      <a href="/admin?c=${n.id}">${escapeHtml(n.name)}</a>
      <span class="count">${n.photoCount}</span>
      <form method="post" action="/admin/categories/${n.id}/delete" class="inline">
        <button type="submit" title="Delete">&times;</button>
      </form>
    </div>
    ${n.children.length ? `<div class="kids">${renderTree(n.children, depth + 1)}</div>` : ''}
  `).join('');
}

function flatten(tree, out = []) {
  for (const n of tree) { out.push(n); flatten(n.children, out); }
  return out;
}

function renderAdmin({ db, activeId }) {
  const tree = listTree(db);
  const flat = flatten(tree);
  const active = activeId ? flat.find(c => c.id === Number(activeId)) : null;
  const photos = listPhotos(db, active ? { categoryId: active.id } : {});

  const thumbs = photos.map(p => `
    <div class="thumb" data-id="${p.id}">
      <img src="/photos/thumb/${escapeHtml(p.filename.replace(/\.[^.]+$/, ''))}.webp" alt="" loading="lazy">
      <form method="post" action="/admin/photos/${p.id}/delete">
        <button class="x" type="submit" aria-label="Delete">&times;</button>
      </form>
      <form method="post" action="/admin/photos/${p.id}" class="meta">
        <input type="date" name="takenAt" value="${escapeHtml(p.takenAt.slice(0, 10))}">
        <input type="text" name="caption" placeholder="Caption" value="${escapeHtml(p.caption ?? '')}">
        <select name="categories" multiple size="3">
          ${flat.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
        <button type="submit">Save</button>
      </form>
    </div>`).join('');

  return layoutPage({
    title: 'Admin — Gage Jack Portfolio',
    styles: ['/css/admin.css'],
    scripts: ['/js/upload.js'],
    body: `
<div class="admin-top">
  <div class="brand">Gage Jack <span class="dim">/ admin</span></div>
  <form method="post" action="/admin/logout"><button type="submit">Log out</button></form>
</div>
<div class="admin-cols">
  <aside class="side">
    ${renderTree(tree)}
    <form method="post" action="/admin/categories" class="add-cat">
      <input name="name" placeholder="New category" required>
      <select name="parentId">
        <option value="">Top level</option>
        ${flat.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
      </select>
      <input name="flag" placeholder="Flag (jp)" maxlength="2">
      <button type="submit">Add</button>
    </form>
  </aside>
  <main class="main">
    <h3>${active ? escapeHtml(active.name) : 'All photos'}</h3>
    <div class="crumb">${photos.length} photos</div>
    <form id="uploader" method="post" action="/admin/upload" enctype="multipart/form-data">
      <label class="drop">
        Drop photos here, or click to choose files
        <input type="file" name="photos" multiple accept="image/*" hidden>
      </label>
    </form>
    <div id="progress"></div>
    <div class="thumbs">${thumbs || '<p class="dim">Nothing here yet.</p>'}</div>
  </main>
</div>`,
  });
}

export function adminRouter({ db, config }) {
  const router = express.Router();

  const staging = stagingDir(config.photosRoot);
  mkdirSync(staging, { recursive: true });

  // Bytes go straight to disk. Holding a 50-photo batch in memory is over a
  // gigabyte and risks an OOM kill on a small VPS.
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, staging),
      filename: (req, file, cb) => cb(null, randomUUID()),
    }),
    limits: { fileSize: config.maxUploadBytes },
  });

  // The queue is generic; this callback is where photo and database knowledge
  // lives. One job = one staged file.
  const queue = createQueue({
    async processJob({ path, name, categoryId }) {
      try {
        const buffer = await readFile(path);
        const meta = await processUpload({
          buffer,
          mtime: new Date(),
          photosRoot: config.photosRoot,
        });
        try {
          const id = insertPhoto(db, meta);
          if (categoryId) setPhotoCategories(db, id, [Number(categoryId)]);
        } catch (dbErr) {
          // Keep disk and database consistent: no orphaned files.
          removePhotoFiles(config.photosRoot, meta.filename);
          throw dbErr;
        }
      } finally {
        // The staged copy is temporary on every path, success or failure.
        await unlink(path).catch(() => {});
      }
    },
  });

  router.get('/admin', requireAuth, (req, res) => {
    res.send(renderAdmin({ db, activeId: req.query.c }));
  });

  router.post('/admin/upload', requireAuth, upload.array('photos', 100), (req, res) => {
    const { batchId, total } = queue.addBatch(
      (req.files ?? []).map(file => ({
        path: file.path,
        name: file.originalname,
        categoryId: req.body.categoryId,
      }))
    );
    // 202: accepted, not yet processed. Progress is at the status endpoint.
    res.status(202).json({ batchId, total });
  });

  router.get('/admin/upload/status/:batchId', requireAuth, (req, res) => {
    const batch = queue.getBatch(req.params.batchId);
    if (!batch) return res.status(404).json({ error: 'unknown batch' });
    res.json(batch);
  });

  router.post('/admin/photos/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const { caption, takenAt } = req.body;
    const patch = {};
    if (caption !== undefined) patch.caption = caption;
    if (takenAt) patch.takenAt = new Date(`${takenAt}T12:00:00Z`).toISOString();
    updatePhoto(db, id, patch);

    if (req.body.categories !== undefined) {
      const ids = [].concat(req.body.categories).filter(Boolean).map(Number);
      setPhotoCategories(db, id, ids);
    }
    res.redirect(req.get('referer') ?? '/admin');
  });

  router.post('/admin/photos/:id/delete', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const photo = getPhoto(db, id);
    if (photo) {
      deletePhoto(db, id);
      removePhotoFiles(config.photosRoot, photo.filename);
    }
    res.redirect(req.get('referer') ?? '/admin');
  });

  router.post('/admin/categories', requireAuth, (req, res) => {
    const { name, parentId, flag } = req.body;
    createCategory(db, {
      name: name.trim(),
      slug: slugify(name),
      parentId: parentId ? Number(parentId) : null,
      flag: flag ? flag.toLowerCase().slice(0, 2) : null,
    });
    res.redirect('/admin');
  });

  router.post('/admin/categories/:id/delete', requireAuth, (req, res) => {
    deleteCategory(db, Number(req.params.id));
    res.redirect('/admin');
  });

  return router;
}
