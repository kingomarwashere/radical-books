// Project Gutenberg — free public-domain ebooks, queried via Gutendex
// (https://gutendex.com), a clean JSON API over the Gutenberg catalog.
// Each book exposes downloadable formats; we prefer EPUB, fall back to plain text.
const BASE = 'https://gutendex.com/books';
const UA = 'RadicalBooks/1.0 (+https://books.theradicalparty.com)';

function j(url) {
  return fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`Gutendex HTTP ${r.status}`)));
}

function pickFormat(formats, ...mimes) {
  for (const m of mimes) {
    for (const [k, v] of Object.entries(formats || {})) {
      if (k.startsWith(m) && !k.includes('zip') === !m.includes('zip')) return v;
    }
  }
  return null;
}

function normalize(b) {
  if (!b) return null;
  const author = (b.authors || [])[0];
  const authorName = author?.name
    ? author.name.split(',').map(s => s.trim()).reverse().join(' ')  // "Twain, Mark" → "Mark Twain"
    : 'Anonymous';
  const epub = b.formats?.['application/epub+zip'] || null;
  // Prefer UTF-8 plain text, avoiding the .zip variants.
  const txt = pickFormat(b.formats, 'text/plain; charset=utf-8', 'text/plain');
  const cover = b.formats?.['image/jpeg'] || null;
  const subjects = [...new Set([...(b.subjects || []), ...(b.bookshelves || [])]
    .flatMap(s => String(s).split(' -- '))
    .map(s => s.trim())
    .filter(s => s && s.length < 40))].slice(0, 8);
  return {
    source: 'gutenberg',
    sourceId: String(b.id),
    title: (b.title || '').trim(),
    authorName,
    authorBirth: author?.birth_year || null,
    authorDeath: author?.death_year || null,
    description: null, // Gutendex has no synopsis; Open Library fills this in
    language: (b.languages || ['en'])[0],
    subjects,
    coverUrl: cover,
    epubUrl: epub,
    txtUrl: (txt && !String(txt).endsWith('.zip')) ? txt : null,
    downloadCount: b.download_count || 0,
  };
}

export async function searchGutenberg(query, { limit = 24 } = {}) {
  const url = `${BASE}?${new URLSearchParams({ search: query, languages: 'en' })}`;
  const data = await j(url).catch(() => null);
  return (data?.results || [])
    .map(normalize)
    .filter(b => b && b.epubUrl)
    .slice(0, limit);
}

export async function getGutenbergBook(id) {
  const data = await j(`${BASE}/${encodeURIComponent(id)}`);
  return normalize(data);
}

// Popular books for bulk seeding (Gutendex sorts by download count by default).
export async function browseGutenberg({ page = 1, topic = null } = {}) {
  const params = { languages: 'en', page: String(page) };
  if (topic) params.topic = topic;
  const data = await j(`${BASE}?${new URLSearchParams(params)}`).catch(() => null);
  return (data?.results || []).map(normalize).filter(b => b && b.epubUrl);
}
