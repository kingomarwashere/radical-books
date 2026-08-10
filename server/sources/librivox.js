// LibriVox — free public-domain audiobooks. The API returns full audiobook
// records including per-chapter listen URLs (MP3), so we can ingest a complete
// audiobook (metadata + chapters) with a single request.
//
// API docs: https://librivox.org/api/info  — `extended=1` includes `sections`.
const BASE = 'https://librivox.org/api/feed/audiobooks';
const UA = 'RadicalBooks/1.0 (+https://books.theradicalparty.com)';

function j(url) {
  return fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`LibriVox HTTP ${r.status}`)));
}

// Normalize a raw LibriVox book record → our ingest descriptor.
function normalize(b) {
  if (!b) return null;
  const authors = (b.authors || [])
    .map(a => [a.first_name, a.last_name].filter(Boolean).join(' ').trim())
    .filter(Boolean);
  const authorName = authors[0] || 'Various';
  const sections = (b.sections || [])
    .filter(s => s.listen_url)
    .sort((a, b2) => (parseInt(a.section_number) || 0) - (parseInt(b2.section_number) || 0))
    .map((s, i) => ({
      idx: i,
      title: (s.title || `Section ${i + 1}`).trim(),
      duration: parseInt(s.playtime) || null,   // seconds
      url: s.listen_url,
    }));
  // Strip LibriVox's boilerplate HTML wrapper from the description.
  const description = (b.description || '').replace(/<[^>]+>/g, '').trim() || null;
  return {
    source: 'librivox',
    sourceId: String(b.id),
    title: (b.title || '').trim(),
    authorName,
    description,
    language: (b.language || 'English').toLowerCase().startsWith('eng') ? 'en' : (b.language || 'en').slice(0, 5).toLowerCase(),
    year: parseInt(b.copyright_year) || null,
    reader: null, // LibriVox readers are per-section; leave null (volunteer readers)
    subjects: (b.genres || []).map(g => g.name).filter(Boolean),
    coverUrl: null, // LibriVox API has no cover; Open Library fills this in at ingest
    runtime: parseInt(b.totaltimesecs) || sections.reduce((a, s) => a + (s.duration || 0), 0) || null,
    urlTextSource: b.url_text_source || null,
    chapters: sections,
  };
}

// Search audiobooks by title. LibriVox's `title` param is a PREFIX match anchored
// at the start of the stored title, so a leading "The"/subtitle breaks it. We try
// progressively looser variants (strip leading article, drop subtitle, shorten)
// and return the first non-empty batch.
export async function searchLibriVox(query, limit = 20) {
  const variants = [];
  const base = (query || '').trim();
  const noArticle = base.replace(/^(the|a|an)\s+/i, '');
  const noSub = noArticle.split(/[:—–-]/)[0].trim();
  const short = noSub.split(/\s+/).slice(0, 5).join(' ');
  for (const v of [base, noArticle, noSub, short]) if (v && !variants.includes(v)) variants.push(v);

  for (const v of variants) {
    const url = `${BASE}?${new URLSearchParams({ title: v, format: 'json', limit: String(limit), extended: '0' })}`;
    const data = await j(url).catch(() => null);
    const books = data?.books || [];
    if (!books.length) continue;
    return books.map(b => ({
      source: 'librivox', sourceId: String(b.id),
      title: (b.title || '').trim(),
      authorName: (b.authors || []).map(a => [a.first_name, a.last_name].filter(Boolean).join(' ')).filter(Boolean)[0] || 'Various',
      runtime: parseInt(b.totaltimesecs) || null,
      numSections: parseInt(b.num_sections) || null,
    }));
  }
  return [];
}

// Fetch one full audiobook (with chapters) by its LibriVox id.
export async function getLibriVoxBook(id) {
  const url = `${BASE}?${new URLSearchParams({ id: String(id), format: 'json', extended: '1' })}`;
  const data = await j(url);
  return normalize((data?.books || [])[0]);
}

// Browse the catalog for bulk seeding — newest-first page of full records.
export async function browseLibriVox({ limit = 30, offset = 0 } = {}) {
  const url = `${BASE}?${new URLSearchParams({ format: 'json', limit: String(limit), offset: String(offset), extended: '1' })}`;
  const data = await j(url).catch(() => null);
  return (data?.books || []).map(normalize).filter(b => b && b.chapters.length);
}
