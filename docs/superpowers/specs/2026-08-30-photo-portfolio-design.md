# Photo Portfolio — Design

**Date:** 2026-08-30
**Status:** Approved for planning
**Domain:** gagejack.com

## Purpose

A personal photography portfolio for Gage Jack. Visitors land on a
chronological feed of photos and browse by time, optionally narrowed to
one category. The owner adds and organizes photos through a private
admin panel. The site is minimal by intent: white background, dark gray
text, no ornament competing with the photographs.

## Success Criteria

- Visitors see photographs within one second of load, at a size that
  does justice to them.
- Adding a batch of photos takes minutes, from a browser, without SSH
  or a redeploy.
- The site runs as one process on an existing Ubuntu server and stays
  up without attention.
- Originals are never lost and never served to browsers.

## Architecture

One Node process serving two surfaces from the same Express app:

- **Public site** — server-rendered HTML, no client framework, no build
  step. Vanilla JavaScript drives the timeline rail and the lightbox.
- **Admin panel** — same server, mounted under `/admin`, behind session
  auth.

Data lives in two places, each suited to what it holds:

- **SQLite** (`better-sqlite3`) — photo metadata, categories, and the
  relationships between them. One file on disk.
- **Filesystem** — image bytes, under a photos root outside the repo.

Cloudflare Tunnel fronts the process. No inbound ports are opened, no
nginx, no certificate management. The origin binds to localhost only.

```
Browser → Cloudflare edge (TLS, gagejack.com)
        → cloudflared tunnel
        → Express on 127.0.0.1:3000
        → SQLite (metadata) + filesystem (image bytes)
```

### Why this shape

The site is read-heavy with exactly one writer. That collapses most of
the usual complexity: no connection pool, no migration coordination, no
cache tier. SQLite's single-writer limitation is not a constraint here,
it is a description of the workload. A framework and build step would
add moving parts without buying anything the site needs.

## Data Model

### `photos`

| Column        | Type    | Notes                                        |
|---------------|---------|----------------------------------------------|
| `id`          | INTEGER | Primary key                                  |
| `filename`    | TEXT    | Stored basename, unique, content-hash based  |
| `taken_at`    | TEXT    | ISO 8601. Drives all ordering                |
| `date_source` | TEXT    | `exif` \| `mtime` \| `manual`                |
| `width`       | INTEGER | Original pixel width                         |
| `height`      | INTEGER | Original pixel height                        |
| `caption`     | TEXT    | Nullable                                     |
| `created_at`  | TEXT    | Upload time                                  |

`width` and `height` are stored so the justified grid can compute row
layout without measuring images in the browser. This prevents the
layout shift that otherwise occurs as photos load.

### `categories`

| Column      | Type    | Notes                                         |
|-------------|---------|-----------------------------------------------|
| `id`        | INTEGER | Primary key                                   |
| `name`      | TEXT    | Display name, capitalized (`Japan`, `Kyoto`)  |
| `slug`      | TEXT    | URL-safe, unique among siblings               |
| `parent_id` | INTEGER | Nullable, self-referencing. NULL = top level  |
| `flag`      | TEXT    | Nullable ISO 3166-1 alpha-2 code (`jp`, `us`) |
| `position`  | INTEGER | Sort order among siblings                     |

Arbitrary nesting depth via `parent_id`. Urban → Japan → Kyoto is three
levels; Nature → Mountains is two; Cars is one. The same table serves
all of them.

`flag` holds a country code, not an image path. The renderer maps the
code to a flat SVG rectangle. Categories without a flag render with the
space reserved, keeping sibling names aligned.

### `photo_categories`

| Column        | Type    | Notes                                  |
|---------------|---------|----------------------------------------|
| `photo_id`    | INTEGER | FK → `photos.id`, cascade delete       |
| `category_id` | INTEGER | FK → `categories.id`, cascade delete   |
| `position`    | INTEGER | Sort order within this category        |

Join table: a photo belongs to any number of categories. A Kyoto street
shot at dusk can be tagged `Urban`, `Kyoto`, and `Nature` at once.

`position` lives on the join row, not on the photo, because ordering is
per-category — a photo may sit third in one category and seventh in
another.

**Tagging a child does not imply its parents.** A photo tagged `Kyoto`
is not automatically in `Urban`. Filtering resolves this at query time
by expanding a category to itself plus all descendants, so selecting
`Urban` returns photos tagged with `Urban`, `Japan`, `Kyoto`, or any
other descendant. This keeps tagging explicit and filtering intuitive.

## Image Pipeline

On upload, `sharp` derives two sizes and the original is preserved
untouched:

| Variant     | Width  | Format | Purpose                        |
|-------------|--------|--------|--------------------------------|
| `thumb`     | 400px  | WebP   | Grid rows                      |
| `display`   | 1600px | WebP   | Lightbox                       |
| `original`  | native | as-is  | Archival. Never served         |

Stored as:

```
photos/
  originals/<hash>.jpg
  display/<hash>.webp
  thumb/<hash>.webp
```

Filenames are derived from a content hash of the original, which makes
uploads idempotent — re-uploading the same file overwrites its own
derivatives rather than creating a duplicate.

Camera JPEGs run 8–15MB. Serving those into a grid is the single
fastest way to make a photo site feel broken, which is why derivative
generation is part of upload rather than an optimization to add later.

EXIF orientation is applied during resize so rotated photos display
correctly.

### Date extraction

`taken_at` is read from EXIF `DateTimeOriginal`. When absent — screenshots,
scans, stripped metadata — it falls back to file modification time, and
`date_source` records which was used so the admin can surface guessed
dates for correction. Any date is editable by hand.

## Public Site

### Layout

- White background throughout.
- Content capped at 1600px and centered. On wider monitors the margins
  absorb the extra width rather than the photos growing without limit.
- Fixed side margin, fixed gutter between photos.

### Navigation

Sticky top bar: title `Gage Jack Portfolio` on the left, links on the
right — `Portfolio` and `Other Projects`. Dark gray text. `Other
Projects` is a placeholder route in this build.

### The grid

A justified grid — photos keep their true aspect ratios, group into
rows, and each row scales so it exactly fills the content width. No
cropping. Portrait and landscape mix without gaps.

Row heights target ~320px and flex from there. The number of photos per
row falls out of the arithmetic: five or six on an ultrawide, two or
three on a laptop, one on a phone. No breakpoints needed.

Layout is computed server-side from the stored dimensions, so rows are
correct before any image loads.

### Ordering and filtering

Photos are ordered by `taken_at`, newest first, always. Selecting a
category filters the feed to that category and its descendants; the
ordering does not change. The default view is all photos.

Chronology governs the public feed unconditionally. The manual
`position` on `photo_categories` orders thumbnails inside the admin
panel and acts as the tie-breaker when two photos share a timestamp —
it never overrides date order for visitors. A timeline and a hand-sorted
sequence are different organizing ideas; mixing them would make the feed
unpredictable.

### The timeline rail

A sticky rail on the right lists years with their months nested beneath.
It scales radially with scroll position: the month at the current scroll
position is largest and near-black, and neighbors shrink and fade with
distance through a smoothstep falloff. Months scale more than years so
the hierarchy stays readable when both are near focus.

Only `transform` and `color` animate, driven from a
`requestAnimationFrame`-throttled scroll listener. Nothing in the rail
triggers layout.

Clicking any year or month scrolls to the first photo of that period.

The rail is derived from the currently filtered set, not fixed. Filtering
to `Cars` rebuilds it from only those photos, so periods with no matching
photos disappear rather than becoming dead targets.

### Lightbox

Clicking a photo opens it large and centered over a dimmed backdrop,
using the `display` variant. Arrow keys and on-screen controls move
through the filtered set in feed order. Escape or a backdrop click
closes it.

## Admin Panel

Mounted at `/admin`, behind session auth.

### Authentication

A single account. The username and an Argon2id password hash live in
environment variables on the server — never in the repository. Login
creates a signed, HTTP-only, `Secure`, `SameSite=Lax` session cookie.

Login attempts are rate-limited by IP to blunt brute force. This is the
only authenticated surface on the site, which is precisely why it gets
the attention.

### Layout

Two columns. The left is a text-only category tree — no boxes, no
backgrounds. Rows nest by indentation, expandable rows carry a rotating
arrow, and flags sit in a fixed-width column so names stay aligned under
their parent regardless of whether a sibling has a flag. Photo counts sit
right-aligned and muted.

The right pane shows the selected category: a drop zone for uploads and a
thumbnail grid of what is already there.

### Operations

- **Upload** — drag-and-drop or file picker, multiple files at once.
  Derivatives and EXIF extraction happen on upload. Progress is shown
  per file.
- **Categorize** — assign a photo to any number of categories.
- **Reorder** — drag thumbnails to set `position` within a category.
- **Edit** — caption and date.
- **Delete** — removes the row, its join rows, and all three files.
- **Manage categories** — create, rename, delete, reorder, re-parent,
  set a flag.

Deleting a category with children requires confirmation and re-parents
or deletes the subtree — it never silently orphans rows.

## Error Handling

| Condition                        | Response                                                    |
|----------------------------------|-------------------------------------------------------------|
| Non-image upload                 | Reject by MIME sniff, not extension. Report per file        |
| Corrupt image, `sharp` throws    | Skip that file, keep the batch, report which failed         |
| Missing EXIF date                | Fall back to mtime, mark `date_source`, surface in admin    |
| Upload exceeds size limit        | Reject before writing to disk                               |
| Disk full during write           | Abort, remove partial files, leave no orphaned DB row       |
| Duplicate upload (same hash)     | Overwrite derivatives, keep one row. Not an error           |
| DB write fails after files land  | Remove written files so disk and DB stay consistent         |
| Missing file for an existing row | Grid renders a placeholder rather than a broken image       |
| Bad login                        | Generic failure message. Never reveal which field was wrong |

The consistent principle: a partial failure must leave neither an
orphaned file nor an orphaned row.

## Security

- Origin binds to `127.0.0.1`. Only the tunnel reaches it.
- Secrets in environment variables, never committed. `.env` is ignored.
- Argon2id password hashing.
- Session cookies: HTTP-only, `Secure`, `SameSite=Lax`.
- Rate-limited login.
- Uploads validated by content sniffing; stored filenames are
  hash-derived, so a user-supplied filename never touches the filesystem.
- Photo files are served as static assets from the photos root only —
  no path traversal into the filesystem.
- Parameterized SQL throughout.

## Testing

- **Unit** — justified row math, category descendant expansion, EXIF
  date extraction and fallback, hash-based filename derivation.
- **Integration** — upload produces exactly three files plus one row;
  delete removes all four; a failed write leaves nothing behind;
  filtering by a parent returns descendants' photos; auth rejects bad
  credentials and unauthenticated `/admin` access.
- **Manual** — the rail's radial falloff and the lightbox are judged by
  eye, not asserted.

Development follows TDD: a failing test before the code that satisfies it.

## Deployment

Target: existing Ubuntu 26.04 server, x86_64, 12 cores, 30GB RAM, 81GB
free.

Prerequisites, none currently installed:

- Node.js (current LTS) via NodeSource — the distribution package is
  too old.
- `build-essential` — required to compile `better-sqlite3`. `sharp`
  ships prebuilt x86_64 binaries and needs no toolchain.

Runtime:

- `systemd` unit runs the app on `127.0.0.1:3000`, restarts on failure,
  starts on boot.
- Named Cloudflare Tunnel routes `gagejack.com` to that port.
  `cloudflared` is already installed. The domain's nameservers must
  point at Cloudflare.
- Backups: nightly `sqlite3 .backup` for the database, `rsync` of the
  photos root. Originals are the irreplaceable asset.

The server runs Ubuntu 26.04 with kernel 7.0, newer than the assistant's
knowledge cutoff. Package names and versions are to be verified against
the machine during setup rather than assumed.

## Out of Scope

Deliberately excluded from this build:

- Multiple user accounts, signup, password reset
- Comments, likes, social features
- Public search
- Image CDN or object storage — the filesystem is correct at this scale;
  moving to object storage later is a path swap, not a rewrite
- `Other Projects` content — the nav link exists, the page is a stub
- Client-side framework or build step

## Open Questions

None. All decisions resolved during design.
