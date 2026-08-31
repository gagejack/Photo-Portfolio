import express from 'express';
import { listPhotos } from '../db/photos.js';
import { listTree } from '../db/categories.js';
import { justify } from '../web/layout.js';
import { layoutPage, escapeHtml } from '../web/render.js';

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const CONTAINER_WIDTH = 1600;
const TARGET_HEIGHT = 320;
const GUTTER = 10;

export function buildRail(photos) {
  const years = new Map();
  for (const p of photos) {
    const d = new Date(p.takenAt);
    const year = d.getUTCFullYear();
    const monthIdx = d.getUTCMonth();
    if (!years.has(year)) years.set(year, new Map());
    const months = years.get(year);
    if (!months.has(monthIdx)) {
      months.set(monthIdx, { label: MONTHS[monthIdx], key: `${year}-${monthIdx}`, firstPhotoId: p.id });
    }
  }
  return [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => ({
      year,
      months: [...months.entries()].sort((a, b) => b[0] - a[0]).map(([, m]) => m),
    }));
}

function flatten(tree, out = []) {
  for (const node of tree) {
    out.push(node);
    flatten(node.children, out);
  }
  return out;
}

function renderFeed({ photos, tree, activeSlug }) {
  const rows = justify(photos, {
    containerWidth: CONTAINER_WIDTH,
    targetHeight: TARGET_HEIGHT,
    gutter: GUTTER,
  });
  const rail = buildRail(photos);

  const filters = [
    `<a class="f ${activeSlug ? '' : 'on'}" href="/">All</a>`,
    ...tree.map(c =>
      `<a class="f ${activeSlug === c.slug ? 'on' : ''}" href="/c/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a>`
    ),
  ].join('');

  const grid = rows.map(row => `
    <div class="row" style="height:${row.height}px">
      ${row.items.map(it => `
        <div class="cell" style="width:${it.width}px">
          <img src="/photos/thumb/${escapeHtml(it.photo.filename.replace(/\.[^.]+$/, ''))}.webp"
               width="${it.width}" height="${row.height}"
               loading="lazy" alt="${escapeHtml(it.photo.caption ?? '')}"
               title="${escapeHtml(it.photo.filename)}"
               data-id="${it.photo.id}"
               data-filename="${escapeHtml(it.photo.filename)}"
               data-full="/photos/display/${escapeHtml(it.photo.filename.replace(/\.[^.]+$/, ''))}.webp">
        </div>`).join('')}
    </div>`).join('');

  const railHtml = rail.map(y => `
    <div class="r-item r-year" data-key="${y.year}-${y.months[0].key.split('-')[1]}">${y.year}</div>
    ${y.months.map(m => `<div class="r-item r-month" data-key="${m.key}" data-photo="${m.firstPhotoId}">${m.label}</div>`).join('')}
  `).join('');

  return layoutPage({
    title: 'Gage Jack Portfolio',
    styles: ['/css/site.css'],
    scripts: ['/js/rail.js', '/js/lightbox.js'],
    body: `
<nav class="pnav">
  <div class="brand">Gage Jack</div>
  <div class="links"><a class="cur" href="/">Portfolio</a><a href="/other-projects">Other Projects</a></div>
</nav>
<div class="filters">${filters}</div>
<div class="stage">
  <div class="feed">${grid || '<p class="empty">No photos yet.</p>'}</div>
  <div class="rail"><div class="rail-inner">${railHtml}</div></div>
</div>
<div class="lightbox" id="lightbox" hidden>
  <button class="lb-close" aria-label="Close">&times;</button>
  <button class="lb-prev" aria-label="Previous">&#8249;</button>
  <img class="lb-img" alt="">
  <button class="lb-next" aria-label="Next">&#8250;</button>
</div>`,
  });
}

export function publicRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const photos = listPhotos(db, {});
    res.send(renderFeed({ photos, tree: listTree(db), activeSlug: null }));
  });

  router.get('/c/:slug', (req, res) => {
    const tree = listTree(db);
    const match = flatten(tree).find(c => c.slug === req.params.slug);
    if (!match) return res.status(404).send('Not found');
    const photos = listPhotos(db, { categoryId: match.id });
    res.send(renderFeed({ photos, tree, activeSlug: match.slug }));
  });

  router.get('/other-projects', (req, res) => {
    res.send(layoutPage({
      title: 'Other Projects',
      styles: ['/css/site.css'],
      body: `<nav class="pnav">
        <div class="brand">Gage Jack</div>
        <div class="links"><a href="/">Portfolio</a><a class="cur" href="/other-projects">Other Projects</a></div>
      </nav><div class="stage"><p class="empty">Coming soon.</p></div>`,
    }));
  });

  return router;
}
