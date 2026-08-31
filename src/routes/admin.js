import express from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { readFile, statfs, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { requireApiAuth } from './auth.js';
import { processUpload, removePhotoFiles, stagingDir } from '../images/pipeline.js';
import { createQueue } from '../images/queue.js';
import {
  insertPhoto, listPhotos, getPhoto, deletePhoto, photoCategoryIds,
  setPhotoCategories, addPhotoCategories, updatePhoto,
} from '../db/photos.js';
import {
  listTree, createCategory, deleteCategory, renameCategory, ancestorIds, CategoryChildrenLimitError,
} from '../db/categories.js';

const slugify = value => String(value).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function flatten(tree, output = []) {
  for (const node of tree) {
    output.push(node);
    flatten(node.children, output);
  }
  return output;
}

function uploadDebugId(req) {
  const supplied = req.get('x-upload-debug-id');
  return supplied && /^[a-zA-Z0-9-]{1,80}$/.test(supplied) ? supplied : randomUUID();
}

function uploadMtime(value) {
  const date = new Date(Number(value));
  // `lastModified` is supplied by the browser in milliseconds. Requests made
  // outside the UI may omit or corrupt it, in which case retaining today's
  // fallback is safer than sending an invalid timestamp to the database.
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

async function storageUsage(path) {
  try {
    const stats = await statfs(path);
    const blockSize = Number(stats.frsize || stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    const freeBytes = Number(stats.bavail) * blockSize;
    return {
      totalBytes,
      // Use filesystem blocks available to this service account, so the bar
      // accurately describes the space uploads can still consume.
      usedBytes: totalBytes - freeBytes,
      freeBytes,
    };
  } catch (error) {
    console.warn('[storage] unable to read filesystem usage', error.message);
    return null;
  }
}

export function adminRouter({ db, config }) {
  const router = express.Router();
  const staging = stagingDir(config.photosRoot);
  mkdirSync(staging, { recursive: true });

  // Upload bytes go straight to disk so large batches never live in memory.
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, callback) => callback(null, staging),
      filename: (req, file, callback) => callback(null, randomUUID()),
    }),
    limits: { fileSize: config.maxUploadBytes },
  });

  function logUploadLifecycle(req, res, next) {
    req.uploadDebugId = uploadDebugId(req);
    const startedAt = Date.now();
    req.once('aborted', () => {
      console.warn('[upload] request aborted', {
        id: req.uploadDebugId,
        contentLength: req.get('content-length') ?? null,
        elapsedMs: Date.now() - startedAt,
      });
    });
    res.once('finish', () => {
      console.info('[upload] request finished', {
        id: req.uploadDebugId,
        status: res.statusCode,
        files: req.files?.length ?? 0,
        fileBytes: req.files?.reduce((total, file) => total + file.size, 0) ?? 0,
        elapsedMs: Date.now() - startedAt,
      });
    });
    next();
  }

  function handleUploadError(error, req, res, next) {
    console.error('[upload] request failed', {
      id: req.uploadDebugId,
      code: error.code ?? null,
      contentLength: req.get('content-length') ?? null,
    }, error);
    if (res.headersSent) return next(error);
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 500).json({
      error: tooLarge ? 'One or more files exceed the per-photo upload limit' : 'Upload failed',
      uploadId: req.uploadDebugId,
    });
  }

  const queue = createQueue({
    async processJob({ path, name, mtime }) {
      const startedAt = Date.now();
      let inputBytes = 0;
      try {
        const buffer = await readFile(path);
        inputBytes = buffer.byteLength;
        const metadata = await processUpload({
          buffer,
          mtime,
          photosRoot: config.photosRoot,
        });
        try {
          insertPhoto(db, metadata);
        } catch (databaseError) {
          removePhotoFiles(config.photosRoot, metadata.filename);
          throw databaseError;
        }
        console.info('[upload] photo processed', {
          name,
          inputBytes,
          width: metadata.width,
          height: metadata.height,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        console.error('[upload] photo processing failed', {
          name,
          inputBytes,
          elapsedMs: Date.now() - startedAt,
          error: error.message,
        });
        throw error;
      } finally {
        await unlink(path).catch(() => {});
      }
    },
  });

  router.get('/api/admin', requireApiAuth, async (req, res) => {
    const categories = listTree(db);
    const flat = flatten(categories);
    const requestedId = req.query.categoryId ? Number(req.query.categoryId) : null;
    const active = requestedId ? flat.find(category => category.id === requestedId) : null;
    if (requestedId && !active) return res.status(404).json({ error: 'Category not found' });
    const photos = listPhotos(db, active ? { categoryId: active.id } : {})
      .map(photo => ({ ...photo, categoryIds: photoCategoryIds(db, photo.id) }));
    const storage = await storageUsage(config.photosRoot);
    return res.json({ photos, categories, activeCategoryId: active?.id ?? null, storage });
  });

  router.patch('/api/admin/photos/:id', requireApiAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!getPhoto(db, id)) return res.status(404).json({ error: 'Photo not found' });
    const body = req.body ?? {};
    const patch = {};
    if (body.caption !== undefined) patch.caption = String(body.caption);
    if (body.takenAt) {
      const parsed = new Date(`${body.takenAt}T12:00:00Z`);
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'Invalid date' });
      patch.takenAt = parsed.toISOString();
    }
    updatePhoto(db, id, patch);
    if (body.categoryIds !== undefined) {
      if (!Array.isArray(body.categoryIds)) return res.status(400).json({ error: 'categoryIds must be an array' });
      setPhotoCategories(db, id, body.categoryIds.map(Number).filter(Number.isInteger));
    }
    return res.json({ ...getPhoto(db, id), categoryIds: photoCategoryIds(db, id) });
  });

  router.delete('/api/admin/photos/:id', requireApiAuth, (req, res) => {
    const id = Number(req.params.id);
    const photo = getPhoto(db, id);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    deletePhoto(db, id);
    removePhotoFiles(config.photosRoot, photo.filename);
    return res.status(204).end();
  });

  router.post('/api/admin/categories', requireApiAuth, (req, res) => {
    const body = req.body ?? {};
    const name = String(body.name ?? '').trim();
    const slug = slugify(name);
    if (!name || !slug) return res.status(400).json({ error: 'Category name is required' });
    const parentId = body.parentId === null || body.parentId === undefined || body.parentId === ''
      ? null
      : Number(body.parentId);
    if (parentId !== null && !Number.isInteger(parentId)) {
      return res.status(400).json({ error: 'Invalid parent category' });
    }
    try {
      const id = createCategory(db, {
        name,
        slug,
        parentId,
        flag: body.flag ? String(body.flag).toLowerCase().slice(0, 2) : null,
      });
      return res.status(201).json({ id });
    } catch (error) {
      return res.status(error instanceof CategoryChildrenLimitError ? 409 : 400).json({ error: error.message });
    }
  });

  router.patch('/api/admin/categories/:id', requireApiAuth, (req, res) => {
    const id = Number(req.params.id);
    const category = flatten(listTree(db)).find(node => node.id === id);
    if (!category) return res.status(404).json({ error: 'Category not found' });

    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    renameCategory(db, id, name);
    return res.json({ ...category, name });
  });

  router.post('/api/admin/categories/:id/photos', requireApiAuth, (req, res) => {
    const categoryId = Number(req.params.id);
    const category = flatten(listTree(db)).find(node => node.id === categoryId);
    if (!category) return res.status(404).json({ error: 'Category not found' });

    const requestedIds = req.body?.photoIds;
    if (!Array.isArray(requestedIds) || !requestedIds.every(Number.isInteger)) {
      return res.status(400).json({ error: 'photoIds must be an array of photo IDs' });
    }
    const photoIds = [...new Set(requestedIds)];
    if (photoIds.some(id => !getPhoto(db, id))) {
      return res.status(404).json({ error: 'One or more photos were not found' });
    }

    const categoryIds = ancestorIds(db, categoryId);
    addPhotoCategories(db, photoIds, categoryIds);
    return res.json({ photoIds, categoryIds });
  });

  router.delete('/api/admin/categories/:id', requireApiAuth, (req, res) => {
    deleteCategory(db, Number(req.params.id));
    return res.status(204).end();
  });

  router.post('/admin/upload', requireApiAuth, logUploadLifecycle, upload.array('photos', 100), (req, res) => {
    const { batchId, total } = queue.addBatch(
      (req.files ?? []).map(file => ({
        path: file.path,
        name: file.originalname,
        mtime: uploadMtime(req.body.mtime),
      })),
    );
    return res.status(202).json({ batchId, total });
  }, handleUploadError);

  router.get('/admin/upload/status/:batchId', requireApiAuth, (req, res) => {
    const batch = queue.getBatch(req.params.batchId);
    if (!batch) return res.status(404).json({ error: 'unknown batch' });
    return res.json(batch);
  });

  return router;
}
