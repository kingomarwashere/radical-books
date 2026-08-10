// Radical Books — SQLite data layer (better-sqlite3).
//
// Domain model:
//   books            one row per work (title + author + metadata + cover)
//   audio_chapters   ordered audiobook chapters for a book (each an R2 audio file)
//   ebook_editions   ebook files for a book (epub/pdf/txt in R2)
//   authors          de-duplicated author records
//
// Reused-from-Sound infra: users (+billing cols), sessions live in express-session
// memory store, jobs (download queue), offers (promo links), feedback, shelves
// (user book collections), liked_books, reading_progress, activity.
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'books.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

export { db };

// ── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS authors (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT UNIQUE,
    bio         TEXT,
    photo_url   TEXT,
    created_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS books (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    slug         TEXT,
    author_id    TEXT,
    author_name  TEXT,
    description  TEXT,
    cover_url    TEXT,
    year         INTEGER,
    language     TEXT DEFAULT 'en',
    subjects     TEXT,               -- JSON array of genre/subject strings
    source       TEXT,               -- librivox | gutenberg | torrent | manual
    source_id    TEXT,               -- id on the source (for de-dup)
    has_audio    INTEGER DEFAULT 0,
    has_ebook    INTEGER DEFAULT 0,
    audio_runtime INTEGER,           -- total seconds (audiobook)
    reader       TEXT,               -- narrator (audiobook)
    popularity   INTEGER DEFAULT 0,  -- Gutenberg download count / OL ratings — for ranking
    featured     INTEGER DEFAULT 0,  -- hand-curated "popular" pick
    added_at     INTEGER,
    UNIQUE(source, source_id)
  );

  CREATE TABLE IF NOT EXISTS audio_chapters (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL,
    idx        INTEGER NOT NULL,
    title      TEXT,
    duration   INTEGER,             -- seconds
    r2_key     TEXT,                -- set when mirrored to R2
    url        TEXT,                -- resolved playable url (CDN or hotlinked source)
    size       INTEGER,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_chapters_book ON audio_chapters(book_id, idx);

  CREATE TABLE IF NOT EXISTS ebook_editions (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL,
    format     TEXT,                -- epub | pdf | txt
    r2_key     TEXT,
    url        TEXT,                -- resolved download url (CDN or hotlinked source)
    size       INTEGER,
    source     TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_editions_book ON ebook_editions(book_id);

  CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    kind       TEXT DEFAULT 'book', -- book | audiobook | ebook
    status     TEXT DEFAULT 'queued',
    payload    TEXT,
    book_id    TEXT,
    progress   INTEGER DEFAULT 0,
    message    TEXT,
    error      TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);

  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    email      TEXT,
    is_admin   INTEGER DEFAULT 0,
    avatar     TEXT,
    created_at INTEGER,
    paid                    INTEGER DEFAULT 0,
    access_type             TEXT,
    trial_ends_at           INTEGER,
    access_expires_at       INTEGER,
    paid_at                 INTEGER,
    stripe_customer_id      TEXT,
    stripe_subscription_id  TEXT,
    offer_monthly_amount    INTEGER,
    offer_code              TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);

  CREATE TABLE IF NOT EXISTS shelves (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    slug        TEXT,
    kind        TEXT DEFAULT 'user', -- user | want | reading | finished | system
    created_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_shelves_user ON shelves(user_id);

  CREATE TABLE IF NOT EXISTS shelf_books (
    shelf_id  TEXT NOT NULL,
    book_id   TEXT NOT NULL,
    added_at  INTEGER,
    PRIMARY KEY (shelf_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS liked_books (
    user_id  TEXT NOT NULL,
    book_id  TEXT NOT NULL,
    liked_at INTEGER,
    PRIMARY KEY (user_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS reading_progress (
    user_id     TEXT NOT NULL,
    book_id     TEXT NOT NULL,
    media_type  TEXT NOT NULL,        -- audio | ebook
    -- audiobook: chapter_idx + position_sec ; ebook: locator (CFI/page) + percent
    chapter_idx INTEGER,
    position_sec REAL,
    locator     TEXT,
    percent     REAL DEFAULT 0,
    finished    INTEGER DEFAULT 0,
    updated_at  INTEGER,
    PRIMARY KEY (user_id, book_id, media_type)
  );
  CREATE INDEX IF NOT EXISTS idx_progress_user ON reading_progress(user_id, updated_at);

  CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    book_id    TEXT NOT NULL,
    media_type TEXT,
    at         INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, at);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS offers (
    code           TEXT PRIMARY KEY,
    free_days      INTEGER DEFAULT 0,
    monthly_amount INTEGER,
    notes          TEXT,
    max_uses       INTEGER,
    uses           INTEGER DEFAULT 0,
    active         INTEGER DEFAULT 1,
    created_at     INTEGER
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT,
    username   TEXT,
    type       TEXT,
    message    TEXT,
    page       TEXT,
    status     TEXT DEFAULT 'open',
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

  CREATE TABLE IF NOT EXISTS requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT,
    query      TEXT,
    media_type TEXT,
    status     TEXT DEFAULT 'open',
    created_at INTEGER
  );
`);

// Migrations for existing DBs (columns added after first deploy).
for (const stmt of [
  `ALTER TABLE books ADD COLUMN popularity INTEGER DEFAULT 0`,
  `ALTER TABLE books ADD COLUMN featured INTEGER DEFAULT 0`,
]) { try { db.exec(stmt); } catch {} }
db.exec(`CREATE INDEX IF NOT EXISTS idx_books_popularity ON books(popularity DESC)`);

const now = () => Date.now();
const slugify = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
export { slugify };

// ── Authors ──────────────────────────────────────────────────────────────────
const _insAuthor = db.prepare(`INSERT INTO authors (id, name, slug, bio, photo_url, created_at)
  VALUES (@id, @name, @slug, @bio, @photo_url, @created_at)`);
const _authorByName = db.prepare(`SELECT * FROM authors WHERE name = ? COLLATE NOCASE`);

export function upsertAuthor({ id, name, bio = null, photoUrl = null }) {
  if (!name) return null;
  const existing = _authorByName.get(name);
  if (existing) return existing;
  const row = { id: id || cryptoId(), name, slug: slugify(name), bio, photo_url: photoUrl, created_at: now() };
  try { _insAuthor.run(row); } catch { return _authorByName.get(name); }
  return row;
}
export function getAuthor(slug) { return db.prepare(`SELECT * FROM authors WHERE slug = ?`).get(slug); }

function cryptoId() { return (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.floor(Math.random() * 1e9)}`); }
export { cryptoId };

// ── Books ────────────────────────────────────────────────────────────────────
const _insBook = db.prepare(`INSERT INTO books
  (id, title, slug, author_id, author_name, description, cover_url, year, language, subjects,
   source, source_id, has_audio, has_ebook, audio_runtime, reader, popularity, featured, added_at)
  VALUES (@id, @title, @slug, @author_id, @author_name, @description, @cover_url, @year, @language, @subjects,
   @source, @source_id, @has_audio, @has_ebook, @audio_runtime, @reader, @popularity, @featured, @added_at)`);

export const getBookBySource = (source, sourceId) =>
  db.prepare(`SELECT * FROM books WHERE source = ? AND source_id = ?`).get(source, sourceId);
export const getBook = (id) => db.prepare(`SELECT * FROM books WHERE id = ?`).get(id);
export const getBookBySlug = (slug) => db.prepare(`SELECT * FROM books WHERE slug = ?`).get(slug);

// Soft-merge across sources: match an existing work by normalized title + author
// so a LibriVox audiobook and a Gutenberg ebook of the same book share one row.
// Leading articles ("the/a/an") and subtitles are stripped so "The Adventures of
// Sherlock Holmes" and "Adventures of Sherlock Holmes" collapse together.
const stripArticle = (s) => (s || '').replace(/^(the|a|an)\s+/i, '').split(/[:—–]/)[0];
export function findBookByTitleAuthor(title, author) {
  const t = slugify(title), tc = slugify(stripArticle(title));
  if (!t && !tc) return null;
  const rows = db.prepare(`SELECT * FROM books WHERE slug IN (?, ?) OR slug LIKE ? OR slug LIKE ?`)
    .all(t, tc, `${t}%`, `${tc}%`);
  // Keep only strong title matches (article-stripped slug equals the query's).
  const candidates = rows.filter(r => slugify(stripArticle(r.title)) === tc || r.slug === t);
  if (!candidates.length) return null;
  const a = author && author !== 'Unknown' ? slugify(author) : null;
  if (!a) return candidates[0];
  // Fuzzy author match handles "Arthur Conan Doyle" vs "Sir Arthur Conan Doyle".
  const authorHit = candidates.find(r => {
    const ra = slugify(r.author_name || '');
    return ra && (ra.includes(a) || a.includes(ra));
  });
  return authorHit || null; // author known but no author match → treat as different work
}

export function createBook(b) {
  const row = {
    id: b.id || cryptoId(),
    title: b.title,
    slug: b.slug || slugify(b.title) || cryptoId().slice(0, 8),
    author_id: b.authorId || null,
    author_name: b.authorName || null,
    description: b.description || null,
    cover_url: b.coverUrl || null,
    year: b.year || null,
    language: b.language || 'en',
    subjects: b.subjects ? JSON.stringify(b.subjects) : null,
    source: b.source || 'manual',
    source_id: b.sourceId || null,
    has_audio: b.hasAudio ? 1 : 0,
    has_ebook: b.hasEbook ? 1 : 0,
    audio_runtime: b.audioRuntime || null,
    reader: b.reader || null,
    popularity: b.popularity || 0,
    featured: b.featured ? 1 : 0,
    added_at: now(),
  };
  _insBook.run(row);
  return row;
}

// Bump a book's popularity / featured flag (idempotent, keeps the max popularity).
export function setPopularity(bookId, { popularity, featured } = {}) {
  db.prepare(`UPDATE books SET
      popularity = MAX(popularity, COALESCE(?, popularity)),
      featured   = COALESCE(?, featured)
    WHERE id = ?`).run(popularity ?? null, featured == null ? null : (featured ? 1 : 0), bookId);
}

export function setBookFlags(bookId, { hasAudio, hasEbook, audioRuntime, reader } = {}) {
  const b = getBook(bookId);
  if (!b) return;
  db.prepare(`UPDATE books SET
      has_audio = COALESCE(?, has_audio),
      has_ebook = COALESCE(?, has_ebook),
      audio_runtime = COALESCE(?, audio_runtime),
      reader = COALESCE(?, reader)
    WHERE id = ?`).run(
    hasAudio == null ? null : (hasAudio ? 1 : 0),
    hasEbook == null ? null : (hasEbook ? 1 : 0),
    audioRuntime ?? null, reader ?? null, bookId,
  );
}

// Public catalog listing with filters. mediaType: audio | ebook | any.
export function listBooks({ mediaType = 'any', subject = null, q = null, limit = 60, offset = 0, sort = 'added' } = {}) {
  const where = [];
  const args = [];
  if (mediaType === 'audio') where.push('has_audio = 1');
  else if (mediaType === 'ebook') where.push('has_ebook = 1');
  else where.push('(has_audio = 1 OR has_ebook = 1)');
  if (subject) { where.push(`subjects LIKE ?`); args.push(`%"${subject}"%`); }
  if (q) { where.push(`(title LIKE ? OR author_name LIKE ?)`); args.push(`%${q}%`, `%${q}%`); }
  const order = sort === 'title' ? 'title COLLATE NOCASE ASC'
    : sort === 'year' ? 'year DESC'
    : sort === 'popular' ? 'featured DESC, popularity DESC, added_at DESC'
    : 'added_at DESC';
  const rows = db.prepare(
    `SELECT * FROM books WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);
  return rows.map(toBookClient);
}

export function countBooks({ mediaType = 'any' } = {}) {
  const cond = mediaType === 'audio' ? 'has_audio = 1' : mediaType === 'ebook' ? 'has_ebook = 1' : '(has_audio = 1 OR has_ebook = 1)';
  return db.prepare(`SELECT COUNT(*) c FROM books WHERE ${cond}`).get().c;
}

// All distinct subjects w/ counts (for browse chips).
export function listSubjects(limit = 40) {
  const counts = new Map();
  for (const { subjects } of db.prepare(`SELECT subjects FROM books WHERE subjects IS NOT NULL`).all()) {
    let arr; try { arr = JSON.parse(subjects); } catch { continue; }
    for (const s of arr || []) counts.set(s, (counts.get(s) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, count]) => ({ name, count }));
}

export function toBookClient(b) {
  if (!b) return null;
  let subjects = [];
  try { subjects = b.subjects ? JSON.parse(b.subjects) : []; } catch {}
  return {
    id: b.id, title: b.title, slug: b.slug,
    author: b.author_name, authorId: b.author_id,
    description: b.description, cover: b.cover_url,
    year: b.year, language: b.language, subjects,
    source: b.source, hasAudio: !!b.has_audio, hasEbook: !!b.has_ebook,
    audioRuntime: b.audio_runtime, reader: b.reader,
    popularity: b.popularity || 0, featured: !!b.featured,
  };
}

// ── Chapters (audiobook) ─────────────────────────────────────────────────────
const _insChapter = db.prepare(`INSERT INTO audio_chapters (id, book_id, idx, title, duration, r2_key, url, size, created_at)
  VALUES (@id, @book_id, @idx, @title, @duration, @r2_key, @url, @size, @created_at)`);

export function addChapter({ bookId, idx, title, duration, r2Key, url, size }) {
  const row = { id: cryptoId(), book_id: bookId, idx, title: title || `Chapter ${idx + 1}`,
    duration: duration || null, r2_key: r2Key || null, url: url || null, size: size || null, created_at: now() };
  _insChapter.run(row);
  return row;
}
export const getChapters = (bookId) =>
  db.prepare(`SELECT * FROM audio_chapters WHERE book_id = ? ORDER BY idx`).all(bookId);
export const clearChapters = (bookId) => db.prepare(`DELETE FROM audio_chapters WHERE book_id = ?`).run(bookId);

// ── Ebook editions ───────────────────────────────────────────────────────────
const _insEdition = db.prepare(`INSERT INTO ebook_editions (id, book_id, format, r2_key, url, size, source, created_at)
  VALUES (@id, @book_id, @format, @r2_key, @url, @size, @source, @created_at)`);

export function addEdition({ bookId, format, r2Key, url, size, source }) {
  const row = { id: cryptoId(), book_id: bookId, format: format || 'epub',
    r2_key: r2Key || null, url: url || null, size: size || null, source: source || null, created_at: now() };
  _insEdition.run(row);
  return row;
}
export const getEditions = (bookId) =>
  db.prepare(`SELECT * FROM ebook_editions WHERE book_id = ? ORDER BY created_at`).all(bookId);

// ── Download queue ───────────────────────────────────────────────────────────
export function enqueueJob({ kind = 'book', payload = {}, bookId = null }) {
  const id = cryptoId();
  db.prepare(`INSERT INTO jobs (id, kind, status, payload, book_id, created_at, updated_at)
    VALUES (?, ?, 'queued', ?, ?, ?, ?)`).run(id, kind, JSON.stringify(payload), bookId, now(), now());
  return id;
}
export const getJob = (id) => db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
export function claimNextJob() {
  const j = db.prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1`).get();
  if (!j) return null;
  const upd = db.prepare(`UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'`).run(now(), j.id);
  if (upd.changes === 0) return claimNextJob();
  return j;
}
export function updateJob(id, { status, progress, message, error, bookId } = {}) {
  db.prepare(`UPDATE jobs SET
      status = COALESCE(?, status),
      progress = COALESCE(?, progress),
      message = COALESCE(?, message),
      error = COALESCE(?, error),
      book_id = COALESCE(?, book_id),
      updated_at = ?
    WHERE id = ?`).run(status ?? null, progress ?? null, message ?? null, error ?? null, bookId ?? null, now(), id);
}
export function requeueStuckJobs() {
  db.prepare(`UPDATE jobs SET status = 'queued' WHERE status = 'running' AND updated_at < ?`).run(now() - 30 * 60 * 1000);
}
export const listRecentJobs = (limit = 50) =>
  db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit);

// ── Users ────────────────────────────────────────────────────────────────────
const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export const getUserById = (id) => db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
export const getUserByUsername = (u) => db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`).get(u);
export const getUserByStripeCustomer = (c) => db.prepare(`SELECT * FROM users WHERE stripe_customer_id = ?`).get(c);

export function createUser({ id, username, password, email = null, trialEndsAt = null }) {
  const isAdmin = ADMIN_USERS.includes(username.toLowerCase()) ? 1 : 0;
  db.prepare(`INSERT INTO users (id, username, password, email, is_admin, created_at, trial_ends_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, username, password, email, isAdmin, now(), trialEndsAt);
  return getUserById(id);
}
export function updateUserEmail(id, email) {
  db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(email, id);
  return getUserById(id);
}
export function setUserAvatar(id, avatar) {
  db.prepare(`UPDATE users SET avatar = ? WHERE id = ?`).run(avatar, id);
  return getUserById(id);
}
export function isAdminUser(user) {
  if (!user) return false;
  return user.is_admin === 1 || ADMIN_USERS.includes((user.username || '').toLowerCase());
}

export function markUserPaid(userId, { accessType = 'stripe', customerId, subscriptionId, expiresAt } = {}) {
  db.prepare(`UPDATE users SET paid = 1, access_type = ?, paid_at = COALESCE(paid_at, ?),
      stripe_customer_id = COALESCE(?, stripe_customer_id),
      stripe_subscription_id = COALESCE(?, stripe_subscription_id),
      access_expires_at = ?
    WHERE id = ?`).run(accessType, now(), customerId ?? null, subscriptionId ?? null, expiresAt ?? null, userId);
  return getUserById(userId);
}
export function revokeUserAccess(userId) {
  db.prepare(`UPDATE users SET paid = 0, access_type = 'expired' WHERE id = ?`).run(userId);
}
export function setUserOffer(userId, { monthlyAmount, code }) {
  db.prepare(`UPDATE users SET offer_monthly_amount = ?, offer_code = ? WHERE id = ?`).run(monthlyAmount, code, userId);
}

// ── Offers (promo links) ─────────────────────────────────────────────────────
export function createOffer({ code, freeDays, monthlyAmount, notes, maxUses }) {
  db.prepare(`INSERT INTO offers (code, free_days, monthly_amount, notes, max_uses, uses, active, created_at)
    VALUES (?, ?, ?, ?, ?, 0, 1, ?)`).run(code, freeDays, monthlyAmount, notes, maxUses, now());
  return getOffer(code);
}
export const getOffer = (code) => db.prepare(`SELECT * FROM offers WHERE code = ? COLLATE NOCASE`).get(code);
export const listOffers = () => db.prepare(`SELECT * FROM offers ORDER BY created_at DESC`).all();
export function setOfferActive(code, active) {
  db.prepare(`UPDATE offers SET active = ? WHERE code = ?`).run(active ? 1 : 0, code);
  return getOffer(code);
}
export const deleteOffer = (code) => db.prepare(`DELETE FROM offers WHERE code = ?`).run(code);
export function consumeOffer(code) { db.prepare(`UPDATE offers SET uses = uses + 1 WHERE code = ?`).run(code); }

// ── Shelves (user book collections) ──────────────────────────────────────────
export function ensureSystemShelves(userId) {
  for (const [kind, name] of [['want', 'Want to read'], ['reading', 'Currently reading'], ['finished', 'Finished']]) {
    const exists = db.prepare(`SELECT id FROM shelves WHERE user_id = ? AND kind = ?`).get(userId, kind);
    if (!exists) db.prepare(`INSERT INTO shelves (id, user_id, name, slug, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(cryptoId(), userId, name, kind, kind, now());
  }
}
export const getShelves = (userId) => {
  ensureSystemShelves(userId);
  return db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM shelf_books sb WHERE sb.shelf_id = s.id) AS count
    FROM shelves s WHERE user_id = ? ORDER BY (kind='user'), created_at`).all(userId);
};
export function createShelf(userId, name) {
  const row = { id: cryptoId(), user_id: userId, name, slug: slugify(name), kind: 'user', created_at: now() };
  db.prepare(`INSERT INTO shelves (id, user_id, name, slug, kind, created_at) VALUES (@id,@user_id,@name,@slug,@kind,@created_at)`).run(row);
  return row;
}
export const getShelf = (id) => db.prepare(`SELECT * FROM shelves WHERE id = ?`).get(id);
export function addToShelf(shelfId, bookId) {
  db.prepare(`INSERT OR IGNORE INTO shelf_books (shelf_id, book_id, added_at) VALUES (?, ?, ?)`).run(shelfId, bookId, now());
}
export function removeFromShelf(shelfId, bookId) {
  db.prepare(`DELETE FROM shelf_books WHERE shelf_id = ? AND book_id = ?`).run(shelfId, bookId);
}
export function getShelfBooks(shelfId) {
  const rows = db.prepare(`SELECT b.* FROM shelf_books sb JOIN books b ON b.id = sb.book_id
    WHERE sb.shelf_id = ? ORDER BY sb.added_at DESC`).all(shelfId);
  return rows.map(toBookClient);
}
export function deleteShelf(userId, shelfId) {
  db.prepare(`DELETE FROM shelves WHERE id = ? AND user_id = ? AND kind = 'user'`).run(shelfId, userId);
  db.prepare(`DELETE FROM shelf_books WHERE shelf_id = ?`).run(shelfId);
}

// ── Likes ────────────────────────────────────────────────────────────────────
export function toggleLike(userId, bookId) {
  const has = db.prepare(`SELECT 1 FROM liked_books WHERE user_id = ? AND book_id = ?`).get(userId, bookId);
  if (has) { db.prepare(`DELETE FROM liked_books WHERE user_id = ? AND book_id = ?`).run(userId, bookId); return false; }
  db.prepare(`INSERT INTO liked_books (user_id, book_id, liked_at) VALUES (?, ?, ?)`).run(userId, bookId, now());
  return true;
}
export function getLikedBooks(userId) {
  const rows = db.prepare(`SELECT b.* FROM liked_books l JOIN books b ON b.id = l.book_id
    WHERE l.user_id = ? ORDER BY l.liked_at DESC`).all(userId);
  return rows.map(toBookClient);
}
export const isLiked = (userId, bookId) => !!db.prepare(`SELECT 1 FROM liked_books WHERE user_id = ? AND book_id = ?`).get(userId, bookId);

// ── Reading / listening progress ─────────────────────────────────────────────
export function saveProgress(userId, bookId, mediaType, { chapterIdx, positionSec, locator, percent, finished } = {}) {
  db.prepare(`INSERT INTO reading_progress (user_id, book_id, media_type, chapter_idx, position_sec, locator, percent, finished, updated_at)
    VALUES (@user_id, @book_id, @media_type, @chapter_idx, @position_sec, @locator, @percent, @finished, @updated_at)
    ON CONFLICT(user_id, book_id, media_type) DO UPDATE SET
      chapter_idx = COALESCE(excluded.chapter_idx, chapter_idx),
      position_sec = COALESCE(excluded.position_sec, position_sec),
      locator = COALESCE(excluded.locator, locator),
      percent = COALESCE(excluded.percent, percent),
      finished = COALESCE(excluded.finished, finished),
      updated_at = excluded.updated_at`).run({
    user_id: userId, book_id: bookId, media_type: mediaType,
    chapter_idx: chapterIdx ?? null, position_sec: positionSec ?? null,
    locator: locator ?? null, percent: percent ?? null,
    finished: finished == null ? null : (finished ? 1 : 0), updated_at: now(),
  });
  db.prepare(`INSERT INTO activity (user_id, book_id, media_type, at) VALUES (?, ?, ?, ?)`).run(userId, bookId, mediaType, now());
}
export const getProgress = (userId, bookId, mediaType) =>
  db.prepare(`SELECT * FROM reading_progress WHERE user_id = ? AND book_id = ? AND media_type = ?`).get(userId, bookId, mediaType);

export function getContinue(userId, limit = 12) {
  const rows = db.prepare(`SELECT rp.*, b.* FROM reading_progress rp JOIN books b ON b.id = rp.book_id
    WHERE rp.user_id = ? AND rp.finished = 0 ORDER BY rp.updated_at DESC LIMIT ?`).all(userId, limit);
  return rows.map(r => ({ ...toBookClient(r), mediaType: r.media_type, percent: r.percent, chapterIdx: r.chapter_idx, positionSec: r.position_sec, locator: r.locator }));
}

// ── Feedback ─────────────────────────────────────────────────────────────────
export function createFeedback({ userId, username, type, message, page }) {
  db.prepare(`INSERT INTO feedback (user_id, username, type, message, page, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, username, type, message, page, now());
}
export const listFeedback = () => db.prepare(`SELECT * FROM feedback ORDER BY created_at DESC`).all();
export const setFeedbackStatus = (id, status) => db.prepare(`UPDATE feedback SET status = ? WHERE id = ?`).run(status, id);
export const deleteFeedback = (id) => db.prepare(`DELETE FROM feedback WHERE id = ?`).run(id);
export const countOpenFeedback = () => db.prepare(`SELECT COUNT(*) c FROM feedback WHERE status = 'open'`).get().c;

// ── Requests ─────────────────────────────────────────────────────────────────
export function createRequest({ userId, query, mediaType }) {
  db.prepare(`INSERT INTO requests (user_id, query, media_type, created_at) VALUES (?, ?, ?, ?)`).run(userId, query, mediaType, now());
}
export const listRequests = () => db.prepare(`SELECT * FROM requests ORDER BY created_at DESC`).all();

// ── Admin stats ──────────────────────────────────────────────────────────────
export function adminOverview() {
  return {
    books: db.prepare(`SELECT COUNT(*) c FROM books`).get().c,
    audiobooks: db.prepare(`SELECT COUNT(*) c FROM books WHERE has_audio = 1`).get().c,
    ebooks: db.prepare(`SELECT COUNT(*) c FROM books WHERE has_ebook = 1`).get().c,
    users: db.prepare(`SELECT COUNT(*) c FROM users`).get().c,
    paid: db.prepare(`SELECT COUNT(*) c FROM users WHERE paid = 1`).get().c,
    queued: db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status IN ('queued','running')`).get().c,
    openFeedback: countOpenFeedback(),
  };
}

// Grandfather any pre-billing users (idempotent, runs at module load).
db.prepare(`UPDATE users SET paid = 1, access_type = 'grandfathered'
  WHERE paid = 0 AND access_type IS NULL AND created_at < ?`).run(0); // no-op on fresh DB; guard for future launch flag
