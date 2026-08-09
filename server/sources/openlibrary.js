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
