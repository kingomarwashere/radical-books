// Google Books — the rich metadata search engine behind Discover (the "TMDB/iTunes
// for books"): great full-text search, covers, descriptions, categories, ratings.
// No API key needed for basic volume search (rate-limited by IP). This is the
// BROWSE layer; actual audio/ebook files come from the acquire resolvers.
const BASE = 'https://www.googleapis.com/books/v1/volumes';
const UA = 'RadicalBooks/1.0 (+https://books.theradicalparty.com)';
const KEY = process.env.GOOGLE_BOOKS_KEY || '';

function j(url) {
  return fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`GoogleBooks HTTP ${r.status}`)));
}

// Upgrade the tiny http thumbnail to a larger https cover.
function bestCover(links) {
  const raw = links?.extraLarge || links?.large || links?.medium || links?.thumbnail || links?.smallThumbnail;
  if (!raw) return null;
  return raw.replace(/^http:/, 'https:').replace(/&edge=curl/, '').replace(/&zoom=\d/, '&zoom=1');
}

function normalize(item) {
  const v = item.volumeInfo || {};
  const isbn = (v.industryIdentifiers || []).find(i => i.type === 'ISBN_13' || i.type === 'ISBN_10')?.identifier || null;
  return {
    source: 'googlebooks',
    gbid: item.id,
    title: v.title + (v.subtitle ? `: ${v.subtitle}` : ''),
    plainTitle: v.title,
    authorName: (v.authors || [])[0] || 'Unknown',
    authors: v.authors || [],
    description: v.description || null,
    categories: (v.categories || []).flatMap(c => c.split(/[/&]/)).map(s => s.trim()).filter(Boolean).slice(0, 6),
    cover: bestCover(v.imageLinks),
    year: v.publishedDate ? parseInt(String(v.publishedDate).slice(0, 4)) : null,
    rating: v.averageRating || null,
    ratingsCount: v.ratingsCount || 0,
    language: v.language || 'en',
    pageCount: v.pageCount || null,
    isbn,
    // Google's own free ebook/audiobook availability (informational).
    googleEbook: item.saleInfo?.isEbook || false,
  };
}

// Primary Discover search. Rich, relevance-ranked results.
export async function searchGoogleBooks(query, { limit = 24, lang = 'en' } = {}) {
  const params = new URLSearchParams({
    q: query, maxResults: String(Math.min(40, limit)), printType: 'books',
    orderBy: 'relevance', country: 'US',
  });
  if (lang) params.set('langRestrict', lang);
  if (KEY) params.set('key', KEY);
  const data = await j(`${BASE}?${params}`).catch(() => null);
  const items = data?.items || [];
  // De-dup by normalized title+author (Google returns many editions of the same work).
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const n = normalize(it);
    if (!n.title) continue;
    const key = `${n.plainTitle}|${n.authorName}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

export async function getGoogleBook(gbid) {
  const data = await j(`${BASE}/${encodeURIComponent(gbid)}${KEY ? `?key=${KEY}` : ''}`).catch(() => null);
  return data ? normalize(data) : null;
}

// Unified Discover search — Google Books when a key is configured (richest, has
// synopses), otherwise Open Library (keyless, reliable). Falls back to OL if
// Google errors/rate-limits. Both return the same normalized shape.
export async function discoverSearch(query, opts = {}) {
  const { searchOpenLibrary } = await import('./openlibrary.js');
  if (KEY) {
    const g = await searchGoogleBooks(query, opts).catch(() => []);
    if (g.length) return g;
  }
  return searchOpenLibrary(query, opts).catch(() => []);
}
