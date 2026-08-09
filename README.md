# Radical Books

Self-hosted **audiobooks + ebooks** at **books.theradicalparty.com** — a spin-off of
[Sound](https://sound.theradicalparty.com) and [Radical Movies](https://movies.theradicalparty.com),
sharing the same architecture, brand, Stripe account, and R2/CDN.

## What it does
- **Browse free**, subscribe to read/listen (72h free trial, then A$5/mo or A$40/yr).
- **Audiobooks** — chapter-by-chapter player with resume, speed control, media-session
  lock-screen controls. Sourced from **LibriVox** (public domain).
- **Ebooks** — in-browser **epub reader** (epub.js) with progress sync, bookmarks,
  font size + sepia/light/dark themes. Sourced from **Project Gutenberg** (via Gutendex).
- **Discover** — search LibriVox + Gutenberg and add any free title to the library.
- Shelves, favourites, cross-device progress, PWA install, SEO landing pages, admin panel,
  promo-link generator, feedback — all mirrored from Sound.

## Content sourcing
Legal-free first: **LibriVox** audiobooks + **Project Gutenberg** ebooks (clean APIs, huge
public-domain catalog). `MIRROR_TO_R2=1` copies media into our own R2/CDN (`books/` key
prefix on the shared `radical-movies-storage` bucket); `MIRROR_TO_R2=0` hotlinks the source
(used for local dev — zero storage setup). Metadata/covers enriched via **Open Library**.
Torrent fallback (AudiobookBay / Anna's Archive) can be added behind the same `enqueueJob`
interface later.

## Stack
- **Node + Express** (`server/index.js`, port **3030**), **better-sqlite3** (`data/books.db`), session auth.
- **Ingest worker** (`run-worker.mjs`) drains the `jobs` queue out-of-process (fetch + R2 upload),
  so downloads never block the web loop.
- **books-proxy** Cloudflare Worker (`cf-proxy/`) fronts the custom domain → VM origin.
- Runs on the **adrian-bingo VM** (66.226.145.153) at `/opt/radical-books`, pm2 `books` + `books-worker`.

## Layout
```
server/
  index.js        Express app, paywall (url-stripping), all routes, SEO mount
  catalog.js      SQLite schema + data layer (books/chapters/editions/users/shelves/…)
  auth.js billing.js offers.js avatars.js   reused-from-Sound infra
  r2.js           multipart R2 upload + url→R2 mirror (audio + epub mime)
  ingest.js       source descriptor → catalog (+ chapters/editions), cross-source merge
  seo.js          robots, sitemap, book landing pages (meta injected into SPA shell)
  sources/        librivox.js  gutenberg.js  openlibrary.js
public/
  index.html app.js style.css   the SPA (home/browse/detail/library/search)
  reader.html     epub.js ebook reader
  upgrade.html login.html admin.html generatelinks.html
  sw.js manifest.json  (PWA; SW never intercepts navigations)
run-worker.mjs run-catalog.mjs   worker + bulk seeder
```

## Local dev
```bash
npm install
cp .env.example .env        # local .env already set to MIRROR_TO_R2=0 (hotlink)
node run-catalog.mjs 20 2   # seed ~20 audiobooks + ~64 ebooks
node server/index.js        # http://localhost:3030
node run-worker.mjs         # (for Discover ingests)
```

## Go-live checklist (VM + Cloudflare + Stripe)
1. **DNS**: add `books` + `books-origin` A records (→ VM 66.226.145.153) in the theradicalparty.com zone.
2. **Deploy**: `git push github main`; on VM `git clone`/`pull` into `/opt/radical-books`, `npm ci`,
   create `.env` (see `.env.example`, set `MIRROR_TO_R2=1`, `R2_UPLOAD_SECRET`, Stripe vars, `GEN_KEY`,
   `SESSION_SECRET`, `ADMIN_USERS=potato,admin`), `pm2 start server/index.js --name books` +
   `pm2 start run-worker.mjs --name books-worker`.
3. **nginx**: map `books-origin.theradicalparty.com` → `127.0.0.1:3030` (like sound-origin).
4. **Proxy worker**: `cd cf-proxy && wrangler deploy` (creates the books.theradicalparty.com custom domain).
5. **Stripe**: `bash scripts/create-stripe.sh` → put the printed price IDs + webhook secret in the VM `.env`.
6. **Seed**: `node run-catalog.mjs 60 4` on the VM (or the admin Seed button) to fill the catalog into R2.
