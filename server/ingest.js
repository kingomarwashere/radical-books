// Ingest pipeline: source descriptor → catalog row (+ chapters/editions), with
// media mirrored into R2 or hotlinked directly from the public-domain source.
//
// MIRROR_TO_R2=1 (prod default) copies audio/epub into our own R2/CDN. Without an
// R2 upload secret (local dev) we hotlink the original LibriVox/Gutenberg URLs,
// which are freely accessible — so the catalog works with zero storage setup.
import {
  createBook, getBook, getBookBySource, findBookByTitleAuthor, setBookFlags, setPopularity,
  addChapter, addEdition, clearChapters, getChapters, getEditions, upsertAuthor, slugify,
} from './catalog.js';
import { uploadUrlToR2, uploadStreamToR2, getStreamUrl } from './r2.js';
import { getLibriVoxBook, searchLibriVox } from './sources/librivox.js';
import { getGutenbergBook, searchGutenberg } from './sources/gutenberg.js';
import { enrich, coverByTitle } from './sources/openlibrary.js';
import { searchTorrentLeech } from './sources/torrentleech.js';
import { findAudiobookBay } from './sources/audiobookbay.js';
import { findLibgenEbook } from './sources/libgen.js';
import { addTorrent, addMagnet, waitForDownload, listAudioFiles, streamFile } from './seedbox.js';
import path from 'node:path';

const SEEDBOX_SAVE_PATH = process.env.SEEDBOX_SAVE_PATH || '/home/seedit4me/torrents/qbittorrent';
const TORRENTS_ENABLED = () => !!process.env.SEEDBOX_USER; // seedbox creds present

const MIRROR = process.env.MIRROR_TO_R2 === '1' || (!!process.env.R2_UPLOAD_SECRET && process.env.MIRROR_TO_R2 !== '0');
const KEY_PREFIX = process.env.R2_KEY_PREFIX || 'books';

function extOf(url) {
  const m = String(url).split('?')[0].match(/\.([a-z0-9]{2,4})$/i);
  return m ? `.${m[1].toLowerCase()}` : '';
}

// Find-or-create the book row for a descriptor, merging across sources by title+author.
function resolveBook(d, { hasAudio = false, hasEbook = false } = {}) {
  const bySource = getBookBySource(d.source, d.sourceId);
  if (bySource) return bySource;
  const merged = findBookByTitleAuthor(d.title, d.authorName);
  if (merged) return merged;
  const author = upsertAuthor({ name: d.authorName });
  return createBook({
    title: d.title, authorId: author?.id, authorName: d.authorName,
    description: d.description, coverUrl: d.coverUrl, year: d.year,
    language: d.language, subjects: d.subjects, source: d.source, sourceId: d.sourceId,
    hasAudio, hasEbook, audioRuntime: d.runtime || null, reader: d.reader || null,
  });
}

// Fill in cover + synopsis from Open Library when the source lacks them.
async function enrichBook(book, d) {
  if (book.cover_url && book.description) return;
  const info = await enrich(d.title, d.authorName).catch(() => ({}));
  const cover = book.cover_url || d.coverUrl || info.coverUrl || coverByTitle(d.title);
  const desc  = book.description || d.description || info.description || null;
  const subjects = (book.subjects && JSON.parse(book.subjects || '[]').length)
    ? undefined
    : (d.subjects?.length ? d.subjects : info.subjects);
  const { db } = await import('./catalog.js');
  db.prepare(`UPDATE books SET cover_url = COALESCE(?, cover_url), description = COALESCE(?, description),
      subjects = COALESCE(?, subjects), year = COALESCE(?, year) WHERE id = ?`)
    .run(cover, desc, subjects ? JSON.stringify(subjects) : null, book.year || info.year || null, book.id);
}

// ── Audiobook (LibriVox) ─────────────────────────────────────────────────────
export async function ingestAudiobook(descriptor, { onProgress } = {}) {
  const d = descriptor.chapters ? descriptor : await getLibriVoxBook(descriptor.sourceId || descriptor.id);
  if (!d || !d.chapters?.length) throw new Error('No audiobook chapters found');

  const book = resolveBook(d, { hasAudio: true });
  await enrichBook(book, d);
  if (getChapters(book.id).length) { setBookFlags(book.id, { hasAudio: true }); return book; } // already ingested

  const total = d.chapters.length;
  for (const ch of d.chapters) {
    let url = ch.url, r2Key = null, size = null;
    if (MIRROR) {
      const key = `${KEY_PREFIX}/audio/${book.id}/${String(ch.idx).padStart(4, '0')}${extOf(ch.url) || '.mp3'}`;
      const r = await uploadUrlToR2(ch.url, key, extOf(ch.url) || '.mp3');
      r2Key = key; url = getStreamUrl(key); size = r.size;
    }
    addChapter({ bookId: book.id, idx: ch.idx, title: ch.title, duration: ch.duration, r2Key, url, size });
    onProgress?.(Math.floor((ch.idx + 1) / total * 100), `chapter ${ch.idx + 1}/${total}`);
  }
  setBookFlags(book.id, { hasAudio: true, audioRuntime: d.runtime, reader: d.reader });
  return getBook(book.id);
}

// ── Ebook (Gutenberg) ────────────────────────────────────────────────────────
export async function ingestEbook(descriptor, { onProgress } = {}) {
  const d = descriptor.epubUrl ? descriptor : await getGutenbergBook(descriptor.sourceId || descriptor.id);
  if (!d || !d.epubUrl) throw new Error('No epub available');

  const book = resolveBook(d, { hasEbook: true });
  await enrichBook(book, d);
  if (d.downloadCount) setPopularity(book.id, { popularity: d.downloadCount });
  if (getEditions(book.id).some(e => e.format === 'epub')) { setBookFlags(book.id, { hasEbook: true }); return book; }

  let url = d.epubUrl, r2Key = null, size = null;
  if (MIRROR) {
    const key = `${KEY_PREFIX}/ebook/${book.id}.epub`;
    const r = await uploadUrlToR2(d.epubUrl, key, '.epub', (p) => onProgress?.(p, 'downloading epub'));
    r2Key = key; url = getStreamUrl(key); size = r.size;
  }
  addEdition({ bookId: book.id, format: 'epub', r2Key, url, size, source: d.source });
  if (d.txtUrl) addEdition({ bookId: book.id, format: 'txt', url: d.txtUrl, source: d.source });
  setBookFlags(book.id, { hasEbook: true });
  onProgress?.(100, 'done');
  return getBook(book.id);
}

// ── Acquire by title/author (Discover → best available source) ───────────────
// Given rich metadata (from Google Books), find the actual media and ingest it:
// audio → LibriVox (free) then torrents (TorrentLeech/AudioBookBay → seedbox);
// ebook → Gutenberg (free) then libgen (direct download). `meta` carries the
// Google Books cover/description so even torrent-sourced books look good.
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function titleMatches(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  const short = x.length < y.length ? x : y, long = x.length < y.length ? y : x;
  return long.includes(short.split(' ').slice(0, 4).join(' '));
}

function chapterTitleFromFile(name, i) {
  return name.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]*/, '').replace(/[_.]+/g, ' ').trim() || `Chapter ${i + 1}`;
}

// Book row from Discover metadata (Google Books or Open Library) — created before
// we know which media source will supply the actual file.
function bookFromMeta(meta) {
  const src = meta.source || 'discover';
  const existing = (meta.gbid && getBookBySource(src, meta.gbid)) || findBookByTitleAuthor(meta.plainTitle || meta.title, meta.authorName);
  if (existing) return existing;
  const author = upsertAuthor({ name: meta.authorName });
  return createBook({
    title: meta.plainTitle || meta.title, authorId: author?.id, authorName: meta.authorName,
    description: meta.description, coverUrl: meta.cover, year: meta.year,
    language: meta.language || 'en', subjects: meta.categories, source: src, sourceId: meta.gbid || null,
  });
}

export async function acquireAudiobook(meta, { onProgress } = {}) {
  const title = meta.plainTitle || meta.title, author = meta.authorName;
  // 1) LibriVox (free, public domain)
  onProgress?.(3, 'searching LibriVox');
  const lv = (await searchLibriVox(title).catch(() => [])).find(r => titleMatches(r.title, title));
  if (lv) { onProgress?.(8, 'found on LibriVox'); return ingestAudiobook({ sourceId: lv.sourceId }, { onProgress }); }

  // 2) Torrents → seedbox → R2
  if (!TORRENTS_ENABLED()) throw new Error('Not on LibriVox and torrents are not configured');
  onProgress?.(10, 'searching torrents');
  let tor = await searchTorrentLeech(title, author, 'audio').catch(() => null);
  if (!tor) tor = await findAudiobookBay(title, author).catch(() => null);
  if (!tor) throw new Error('No audiobook torrent found');

  const book = bookFromMeta(meta);
  await enrichBook(book, { title, authorName: author, coverUrl: meta.cover, description: meta.description, subjects: meta.categories });
  const savePath = `${SEEDBOX_SAVE_PATH}/${book.id}`;
  onProgress?.(15, `downloading: ${tor.title}`);
  const hash = tor.torrentBuf ? await addTorrent(tor.torrentBuf, savePath) : await addMagnet(tor.magnet, savePath);
  const info = await waitForDownload(hash, (p, st) => onProgress?.(15 + Math.floor(p * 0.6), `torrent ${p}% (${st})`));
  const remote = info?.content_path || info?.save_path || savePath;
  const files = await listAudioFiles(remote);
  if (!files.length) throw new Error('No audio files in torrent');
  clearChapters(book.id);
  for (let i = 0; i < files.length; i++) {
    const f = files[i], ext = path.extname(f.name) || '.mp3';
    const key = `${KEY_PREFIX}/audio/${book.id}/${String(i).padStart(4, '0')}${ext}`;
    const readable = await streamFile(f.path);
    await uploadStreamToR2(readable, f.size, key, ext);
    addChapter({ bookId: book.id, idx: i, title: chapterTitleFromFile(f.name, i), r2Key: key, url: getStreamUrl(key), size: f.size });
    onProgress?.(75 + Math.floor((i + 1) / files.length * 24), `uploading ${i + 1}/${files.length}`);
  }
  setBookFlags(book.id, { hasAudio: true });
  return getBook(book.id);
}

export async function acquireEbook(meta, { onProgress } = {}) {
  const title = meta.plainTitle || meta.title, author = meta.authorName;
  // 1) Project Gutenberg (free, public domain)
  onProgress?.(4, 'searching Gutenberg');
  const gb = (await searchGutenberg(title).catch(() => [])).find(r => titleMatches(r.title, title));
  if (gb) { onProgress?.(10, 'found on Gutenberg'); return ingestEbook({ sourceId: gb.sourceId, ...gb }, { onProgress }); }

  // 2) libgen direct download
  onProgress?.(12, 'searching libgen');
  const lg = await findLibgenEbook(title, author).catch(() => null);
  if (!lg) throw new Error('Not on Gutenberg and no libgen match');
  const book = bookFromMeta(meta);
  await enrichBook(book, { title, authorName: author, coverUrl: meta.cover, description: meta.description, subjects: meta.categories });
  let url = lg.url, r2Key = null, size = null;
  if (MIRROR) {
    const key = `${KEY_PREFIX}/ebook/${book.id}.${lg.format || 'epub'}`;
    onProgress?.(40, 'downloading ebook');
    const r = await uploadUrlToR2(lg.url, key, `.${lg.format || 'epub'}`);
    r2Key = key; url = getStreamUrl(key); size = r.size;
  }
  addEdition({ bookId: book.id, format: lg.format || 'epub', r2Key, url, size, source: 'libgen' });
  setBookFlags(book.id, { hasEbook: true });
  onProgress?.(100, 'done');
  return getBook(book.id);
}

// Bulk-seed the catalog from LibriVox + Gutenberg (used by the admin Seed button).
export async function seedCatalog({ audio = 20, ebooks = 2 } = {}, { onProgress } = {}) {
  const { browseLibriVox } = await import('./sources/librivox.js');
  const { browseGutenberg } = await import('./sources/gutenberg.js');
  let done = 0, offset = 0;
  while (done < audio) {
    const batch = await browseLibriVox({ limit: 20, offset });
    if (!batch.length) break;
    offset += batch.length;
    for (const d of batch) { if (done >= audio) break; try { await ingestAudiobook(d); done++; onProgress?.(Math.floor(done / (audio + ebooks * 32) * 100), `audio ${done}`); } catch {} }
  }
  let e = 0;
  for (let page = 1; page <= ebooks; page++) {
    for (const d of await browseGutenberg({ page })) { try { await ingestEbook(d); e++; onProgress?.(null, `ebook ${e}`); } catch {} }
  }
  return { audiobooks: done, ebooks: e };
}

// Generic job runner used by the worker; writes live progress to the jobs table.
export async function runJob(job, { updateJob } = {}) {
  const payload = JSON.parse(job.payload || '{}');
  const onProgress = (progress, message) => updateJob?.(job.id, { progress, message });
  if (job.kind === 'seed') {
    const r = await seedCatalog(payload, { onProgress });
    updateJob?.(job.id, { status: 'done', progress: 100, message: `seeded ${r.audiobooks} audio + ${r.ebooks} ebooks` });
    return r;
  }
  const book = job.kind === 'audiobook' ? await ingestAudiobook(payload, { onProgress })
    : job.kind === 'ebook' ? await ingestEbook(payload, { onProgress })
    : job.kind === 'acquire-audio' ? await acquireAudiobook(payload, { onProgress })
    : job.kind === 'acquire-ebook' ? await acquireEbook(payload, { onProgress })
    : (() => { throw new Error(`Unknown job kind: ${job.kind}`); })();
  updateJob?.(job.id, { status: 'done', progress: 100, bookId: book.id, message: 'complete' });
  return book;
}
