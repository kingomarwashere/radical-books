// Ingest pipeline: source descriptor → catalog row (+ chapters/editions), with
// media mirrored into R2 or hotlinked directly from the public-domain source.
//
// MIRROR_TO_R2=1 (prod default) copies audio/epub into our own R2/CDN. Without an
// R2 upload secret (local dev) we hotlink the original LibriVox/Gutenberg URLs,
// which are freely accessible — so the catalog works with zero storage setup.
import {
  createBook, getBook, getBookBySource, findBookByTitleAuthor, setBookFlags,
  addChapter, addEdition, clearChapters, getChapters, getEditions, upsertAuthor, slugify,
} from './catalog.js';
import { uploadUrlToR2, getStreamUrl } from './r2.js';
import { getLibriVoxBook } from './sources/librivox.js';
import { getGutenbergBook } from './sources/gutenberg.js';
import { enrich, coverByTitle } from './sources/openlibrary.js';

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
    : (() => { throw new Error(`Unknown job kind: ${job.kind}`); })();
  updateJob?.(job.id, { status: 'done', progress: 100, bookId: book.id, message: 'complete' });
  return book;
}
