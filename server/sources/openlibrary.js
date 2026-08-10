// Open Library — used to enrich records that ship without a cover or synopsis
// (notably LibriVox audiobooks and Gutenberg ebooks). Free, no key.
const UA = 'RadicalBooks/1.0 (+https://books.theradicalparty.com)';

function j(url) {
  return fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`OpenLibrary HTTP ${r.status}`)));
}

// Look up a work by title + author, returning { coverUrl, description, subjects, year }.
export async function enrich(title, author) {
  if (!title) return {};
  const q = new URLSearchParams({ title, limit: '3' });
  if (author && author !== 'Various' && author !== 'Anonymous') q.set('author', author);
  const data = await j(`https://openlibrary.org/search.json?${q}`).catch(() => null);
  const doc = (data?.docs || [])[0];
  if (!doc) return {};
  const coverUrl = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null;
  let description = null;
  if (doc.key) {
    const work = await j(`https://openlibrary.org${doc.key}.json`).catch(() => null);
    const d = work?.description;
    description = typeof d === 'string' ? d : d?.value || null;
    if (description) description = description.replace(/\r?\n?----.*$/s, '').replace(/\[.*?\]\(.*?\)/g, '').trim();
  }
  return {
    coverUrl,
    description,
    subjects: (doc.subject || []).slice(0, 8),
    year: doc.first_publish_year || null,
  };
}

// Deterministic cover fallback when no image is available anywhere.
export function coverByTitle(title) {
  return `https://covers.openlibrary.org/b/title/${encodeURIComponent(title)}-L.jpg`;
}

// Rich, keyless Discover search (the open "TMDB for books"). Normalized to the
// same shape Google Books returns so the UI + acquire flow are engine-agnostic.
export async function searchOpenLibrary(query, { limit = 24 } = {}) {
  const params = new URLSearchParams({
    q: query, limit: String(limit),
    fields: 'key,title,author_name,first_publish_year,cover_i,subject,ratings_average,ratings_count,language, isbn,ia,ebook_access',
  });
  const data = await j(`https://openlibrary.org/search.json?${params}`).catch(() => null);
  const docs = data?.docs || [];
  const seen = new Set();
  const out = [];
  for (const d of docs) {
    const title = (d.title || '').trim();
    const author = (d.author_name || [])[0] || 'Unknown';
    if (!title) continue;
    const key = `${title}|${author}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: 'openlibrary',
      gbid: d.key,                                   // e.g. /works/OL12345W
      title, plainTitle: title,
      authorName: author, authors: d.author_name || [],
      description: null,                             // filled at ingest via enrich()
      categories: (d.subject || []).slice(0, 6),
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
      year: d.first_publish_year || null,
      rating: d.ratings_average ? Math.round(d.ratings_average * 10) / 10 : null,
      ratingsCount: d.ratings_count || 0,
      language: (d.language || ['eng'])[0],
      isbn: (d.isbn || [])[0] || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}
