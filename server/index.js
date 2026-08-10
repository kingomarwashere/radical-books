import './net.js';
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as C from './catalog.js';
import authRouter from './auth.js';
import { getPaidInfo, billingRoutes, handleWebhook } from './billing.js';
import { offerRoutes } from './offers.js';
import { AVATAR_PRESETS, resolveAvatar, isValidAvatar } from './avatars.js';
import { discoverSearch } from './sources/googlebooks.js';
import { openLibraryTrending } from './curated.js';
import { seoRoutes } from './seo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3030;

const app = express();
app.set('trust proxy', 1);

// Stripe webhook needs the raw body — mount BEFORE express.json().
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleWebhook);

app.use(express.json({ limit: '1mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'radical-books-dev-secret',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 90, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' },
}));

// ── Middleware ───────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}
function requirePaid(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Not logged in' });
  if (!getPaidInfo(req.session.user.id).paid) return res.status(402).json({ error: 'Subscription required', paywall: true });
  next();
}
function requireAdmin(req, res, next) {
  const u = req.session?.user && C.getUserById(req.session.user.id);
  if (!u || !C.isAdminUser(u)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Paywall enforcement: browsing is free, but non-subscribers must never receive a
// playable/readable `url`. We wrap res.json and recursively strip every `url` key
// for unpaid users (clone first, so cached DB objects aren't mutated). They resolve
// URLs on demand via the requirePaid endpoints below, which 402 when unpaid.
function stripUrls(v) {
  if (Array.isArray(v)) return v.map(stripUrls);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) { if (k === 'url') continue; out[k] = stripUrls(val); }
    return out;
  }
  return v;
}
app.use((req, res, next) => {
  const paid = req.session?.user ? getPaidInfo(req.session.user.id).paid : false;
  if (paid || req.path.startsWith('/api/billing') || req.path.startsWith('/api/offer')) return next();
  const orig = res.json.bind(res);
  res.json = (body) => orig(stripUrls(body));
  next();
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', loginLimiter);

// ── Auth / billing / offers ──────────────────────────────────────────────────
app.use('/api/auth', authRouter);
billingRoutes(app, { requireAuth });
offerRoutes(app);

app.get('/api/me', (req, res) => {
  if (!req.session?.user) return res.json({ user: null });
  const u = C.getUserById(req.session.user.id);
  if (!u) return res.json({ user: null });
  const info = getPaidInfo(u);
  res.json({
    user: { id: u.id, username: u.username, email: u.email, avatar: resolveAvatar(u), isAdmin: C.isAdminUser(u) },
    access: { paid: info.paid, inTrial: info.inTrial, trialEndsAt: info.trialEndsAt, accessType: info.accessType, accessExpiresAt: info.accessExpiresAt },
  });
});

// ── Catalog (browse — free) ──────────────────────────────────────────────────
app.get('/api/books', (req, res) => {
  const { media = 'any', subject, q, sort = 'added' } = req.query;
  const limit = Math.min(100, parseInt(req.query.limit) || 60);
  const offset = parseInt(req.query.offset) || 0;
  res.json({
    books: C.listBooks({ mediaType: media, subject, q, sort, limit, offset }),
    total: C.countBooks({ mediaType: media }),
  });
});

app.get('/api/subjects', (_req, res) => res.json({ subjects: C.listSubjects() }));

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ books: [] });
  res.json({ books: C.listBooks({ q, limit: 40 }) });
});

// Cached "trending now" — Open Library trending intersected with books we have.
let _trending = { at: 0, books: [] };
async function trendingBooks() {
  if (Date.now() - _trending.at < 60 * 60 * 1000) return _trending.books;
  const list = await openLibraryTrending('weekly').catch(() => []);
  const seen = new Set(), have = [];
  for (const t of list) {
    const row = C.findBookByTitleAuthor(t.title, t.author);
    if (row && !seen.has(row.id)) { seen.add(row.id); have.push(C.toBookClient(row)); }
    if (have.length >= 18) break;
  }
  _trending = { at: Date.now(), books: have };
  return have;
}

const cleanGenre = (s) => s.replace(/^Category:\s*/i, '').trim();

app.get('/api/home', async (req, res) => {
  const uid = req.session?.user?.id;
  const sections = [];
  // Lead with popularity so recognizable books surface first (not obscure archive rows).
  sections.push({ title: 'Popular right now', books: C.listBooks({ sort: 'popular', limit: 18 }) });
  const trending = await trendingBooks().catch(() => []);
  if (trending.length >= 4) sections.push({ title: 'Trending this week', books: trending });
  sections.push({ title: 'Popular audiobooks', books: C.listBooks({ mediaType: 'audio', sort: 'popular', limit: 18 }) });
  sections.push({ title: 'Popular ebooks', books: C.listBooks({ mediaType: 'ebook', sort: 'popular', limit: 18 }) });
  sections.push({ title: 'Just added', books: C.listBooks({ sort: 'added', limit: 18 }) });
  for (const s of C.listSubjects(20)) {
    const label = cleanGenre(s.name);
    if (/^(fiction|general|literature)$/i.test(label)) continue; // too generic
    const books = C.listBooks({ subject: s.name, sort: 'popular', limit: 14 });
    if (books.length >= 5) sections.push({ title: label, subject: s.name, books });
  }
  res.json({ continue: uid ? C.getContinue(uid) : [], sections: sections.filter(s => s.books.length >= 4).slice(0, 10) });
});

// Book detail (chapters/editions include `url`, stripped for unpaid by middleware).
app.get('/api/book/:id', (req, res) => {
  const b = C.getBook(req.params.id) || C.getBookBySlug(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const uid = req.session?.user?.id;
  res.json({
    book: C.toBookClient(b),
    chapters: C.getChapters(b.id).map(c => ({ idx: c.idx, title: c.title, duration: c.duration, url: c.url })),
    editions: C.getEditions(b.id).map(e => ({ format: e.format, size: e.size, url: e.url })),
    liked: uid ? C.isLiked(uid, b.id) : false,
    progress: {
      audio: uid ? C.getProgress(uid, b.id, 'audio') : null,
      ebook: uid ? C.getProgress(uid, b.id, 'ebook') : null,
    },
  });
});

app.get('/api/author/:slug', (req, res) => {
  const a = C.getAuthor(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json({ author: { name: a.name, slug: a.slug, bio: a.bio, photo: a.photo_url }, books: C.listBooks({ q: a.name, limit: 60 }) });
});

// ── Gated URL resolution (402 when unpaid) ───────────────────────────────────
app.get('/api/book/:id/audio/:idx/url', requirePaid, (req, res) => {
  const ch = C.getChapters(req.params.id).find(c => c.idx === parseInt(req.params.idx));
  if (!ch?.url) return res.status(404).json({ error: 'Not found' });
  res.json({ url: ch.url });
});
app.get('/api/book/:id/ebook/url', requirePaid, (req, res) => {
  const fmt = req.query.format || 'epub';
  const ed = C.getEditions(req.params.id).find(e => e.format === fmt) || C.getEditions(req.params.id)[0];
  if (!ed?.url) return res.status(404).json({ error: 'Not found' });
  res.json({ url: ed.url, format: ed.format });
});
// Same-origin proxy for the ebook bytes — avoids CORS when epub.js loads a file
// that lives on Gutenberg or the CDN. Gated by requirePaid.
app.get('/api/book/:id/ebook/file', requirePaid, async (req, res) => {
  const fmt = req.query.format || 'epub';
  const ed = C.getEditions(req.params.id).find(e => e.format === fmt) || C.getEditions(req.params.id)[0];
  if (!ed?.url) return res.status(404).json({ error: 'Not found' });
  try {
    const up = await fetch(ed.url, { headers: { 'User-Agent': 'RadicalBooks/1.0' }, signal: AbortSignal.timeout(60000) });
    if (!up.ok || !up.body) return res.status(502).json({ error: 'source unavailable' });
    res.setHeader('Content-Type', fmt === 'epub' ? 'application/epub+zip' : fmt === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const { Readable } = await import('node:stream');
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Library actions (auth) ───────────────────────────────────────────────────
app.post('/api/book/:id/like', requireAuth, (req, res) => {
  if (!C.getBook(req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json({ liked: C.toggleLike(req.session.user.id, req.params.id) });
});
app.get('/api/me/likes', requireAuth, (req, res) => res.json({ books: C.getLikedBooks(req.session.user.id) }));

app.get('/api/shelves', requireAuth, (req, res) => {
  res.json({ shelves: C.getShelves(req.session.user.id).map(s => ({ id: s.id, name: s.name, kind: s.kind, count: s.count })) });
});
app.post('/api/shelves', requireAuth, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  res.json({ shelf: C.createShelf(req.session.user.id, name) });
});
app.get('/api/shelf/:id', requireAuth, (req, res) => {
  const s = C.getShelf(req.params.id);
  if (!s || s.user_id !== req.session.user.id) return res.status(404).json({ error: 'Not found' });
  res.json({ shelf: { id: s.id, name: s.name, kind: s.kind }, books: C.getShelfBooks(s.id) });
});
app.post('/api/shelf/:id/add', requireAuth, (req, res) => {
  const s = C.getShelf(req.params.id);
  if (!s || s.user_id !== req.session.user.id) return res.status(404).json({ error: 'Not found' });
  C.addToShelf(s.id, req.body?.bookId);
  res.json({ ok: true });
});
app.post('/api/shelf/:id/remove', requireAuth, (req, res) => {
  const s = C.getShelf(req.params.id);
  if (!s || s.user_id !== req.session.user.id) return res.status(404).json({ error: 'Not found' });
  C.removeFromShelf(s.id, req.body?.bookId);
  res.json({ ok: true });
});
app.delete('/api/shelf/:id', requireAuth, (req, res) => { C.deleteShelf(req.session.user.id, req.params.id); res.json({ ok: true }); });

// Progress (auth; saved on both trial + paid so resume survives).
app.post('/api/book/:id/progress', requireAuth, (req, res) => {
  const { mediaType, chapterIdx, positionSec, locator, percent, finished } = req.body || {};
  if (!['audio', 'ebook'].includes(mediaType)) return res.status(400).json({ error: 'Bad mediaType' });
  C.saveProgress(req.session.user.id, req.params.id, mediaType, { chapterIdx, positionSec, locator, percent, finished });
  res.json({ ok: true });
});
app.get('/api/me/continue', requireAuth, (req, res) => res.json({ books: C.getContinue(req.session.user.id) }));

// ── Discover + ingest (add public-domain titles to the library) ──────────────
// Discover = rich Google Books search (the "TMDB for books"). Results carry
// cover/description/rating/categories; the client offers Get audiobook / Get ebook,
// which POST /api/acquire to resolve the actual media (free → torrent/direct).
app.get('/api/discover', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const results = await discoverSearch(q, { limit: 24 }).catch(() => []);
  res.json({ results });
});

// Acquire a discovered book in a given format. Enqueues a resolver job; the worker
// tries the free source first, then torrents (audio) / libgen (ebook).
app.post('/api/acquire', requireAuth, (req, res) => {
  const { mediaType } = req.body || {};
  if (!['audio', 'ebook'].includes(mediaType)) return res.status(400).json({ error: 'Bad mediaType' });
  const b = req.body || {};
  const meta = {
    gbid: b.gbid, source: 'googlebooks',
    title: b.title, plainTitle: b.plainTitle || b.title,
    authorName: b.authorName || b.author || 'Unknown',
    cover: b.cover, description: b.description,
    categories: Array.isArray(b.categories) ? b.categories.slice(0, 8) : [],
    year: b.year || null, language: b.language || 'en',
  };
  if (!meta.title) return res.status(400).json({ error: 'title required' });
  const jobId = C.enqueueJob({ kind: mediaType === 'audio' ? 'acquire-audio' : 'acquire-ebook', payload: meta });
  res.json({ ok: true, jobId });
});

// Direct source ingest (used by the bulk seeder / admin; source-specific ids).
app.post('/api/ingest', requireAuth, (req, res) => {
  const { source, sourceId, mediaType } = req.body || {};
  if (!sourceId || !['audio', 'ebook'].includes(mediaType)) return res.status(400).json({ error: 'Bad request' });
  const kind = mediaType === 'audio' ? 'audiobook' : 'ebook';
  const jobId = C.enqueueJob({ kind, payload: { source, sourceId } });
  res.json({ ok: true, jobId });
});
app.get('/api/job/:id', requireAuth, (req, res) => {
  const j = C.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  res.json({ id: j.id, status: j.status, progress: j.progress, message: j.message, error: j.error, bookId: j.book_id });
});
app.post('/api/request', requireAuth, (req, res) => {
  C.createRequest({ userId: req.session.user.id, query: (req.body?.query || '').slice(0, 200), mediaType: req.body?.mediaType });
  res.json({ ok: true });
});

// ── Avatars + feedback ───────────────────────────────────────────────────────
app.get('/api/avatars', (_req, res) => res.json({ presets: AVATAR_PRESETS }));
app.patch('/api/me/avatar', requireAuth, (req, res) => {
  const url = req.body?.avatar;
  if (url && !isValidAvatar(url)) return res.status(400).json({ error: 'Invalid avatar' });
  const u = C.setUserAvatar(req.session.user.id, url || null);
  res.json({ ok: true, avatar: resolveAvatar(u) });
});
app.post('/api/feedback', requireAuth, (req, res) => {
  const { type, message, page } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
  C.createFeedback({ userId: req.session.user.id, username: req.session.user.username, type: type || 'general', message: message.trim().slice(0, 4000), page });
  res.json({ ok: true });
});

// ── Admin ────────────────────────────────────────────────────────────────────
app.get('/api/admin/whoami', (req, res) => {
  const u = req.session?.user && C.getUserById(req.session.user.id);
  res.json({ admin: !!(u && C.isAdminUser(u)) });
});
app.get('/api/admin/overview', requireAdmin, (_req, res) => res.json(C.adminOverview()));
app.get('/api/admin/jobs', requireAdmin, (_req, res) => res.json({ jobs: C.listRecentJobs() }));
app.get('/api/admin/feedback', requireAdmin, (_req, res) => res.json({ feedback: C.listFeedback() }));
app.post('/api/admin/feedback/:id/status', requireAdmin, (req, res) => { C.setFeedbackStatus(req.params.id, req.body?.status || 'open'); res.json({ ok: true }); });
app.delete('/api/admin/feedback/:id', requireAdmin, (req, res) => { C.deleteFeedback(req.params.id); res.json({ ok: true }); });
app.get('/api/admin/requests', requireAdmin, (_req, res) => res.json({ requests: C.listRequests() }));
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const rows = C.db.prepare(`SELECT id, username, email, created_at, paid, access_type, trial_ends_at, access_expires_at FROM users ORDER BY created_at DESC`).all();
  res.json({ users: rows });
});
app.post('/api/admin/users/:id/grant', requireAdmin, (req, res) => {
  const days = req.body?.days;
  const expiresAt = days && days !== 'lifetime' ? Date.now() + parseInt(days) * 86400000 : null;
  C.markUserPaid(req.params.id, { accessType: 'comp', expiresAt });
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/revoke', requireAdmin, (req, res) => { C.revokeUserAccess(req.params.id); res.json({ ok: true }); });
// Kick off bulk seeding via the queue (uses run-catalog logic through the worker).
app.post('/api/admin/seed', requireAdmin, (req, res) => {
  const jobId = C.enqueueJob({ kind: 'seed', payload: { audio: req.body?.audio ?? 20, ebooks: req.body?.ebooks ?? 2 } });
  res.json({ ok: true, jobId, note: 'Or run `node run-catalog.mjs` on the server for bulk seeding.' });
});

// ── SEO (robots, sitemap, server-rendered book landing pages) ────────────────
seoRoutes(app);

// ── Static + SPA fallback ────────────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', setHeaders: (res, p) => { if (/\.(html)$/.test(p)) res.setHeader('Cache-Control', 'no-store'); } }));
const page = (name) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, name));
app.get('/reader', page('reader.html'));
app.get('/upgrade', page('upgrade.html'));
app.get('/login', page('login.html'));
app.get('/admin', page('admin.html'));
app.get('/generatelinks', page('generatelinks.html'));
// SPA: any non-API, non-file path serves index.html (book/author/shelf routes handled client-side).
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const server = app.listen(PORT, () => console.log(`[radical-books] http://localhost:${PORT}`));

function shutdown() { console.log('[radical-books] shutting down'); server.close(() => { try { C.db.pragma('wal_checkpoint(TRUNCATE)'); C.db.close(); } catch {} process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
