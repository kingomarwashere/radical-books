// Library Genesis — ebook direct download (no torrent/seedbox needed; libgen
// mirrors serve the file over HTTP, so we fetch it straight into R2). Used as the
// ebook fallback when a title isn't on Project Gutenberg (i.e. modern books).
// Mirrors move around, so both the search + download hosts are configurable.
import * as cheerio from 'cheerio';

const SEARCH_BASE = process.env.LIBGEN_BASE || 'https://libgen.is';
const RESOLVE_BASE = process.env.LIBGEN_RESOLVE || 'http://library.lol';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function html(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`libgen HTTP ${res.status}`);
  return res.text();
}

// Search fiction, preferring EPUB. Returns [{title, author, md5, ext, sizeText}].
export async function searchLibgen(title, author, { ext = 'epub' } = {}) {
  const q = [author, title].filter(Boolean).join(' ');
  const url = `${SEARCH_BASE}/fiction/?q=${encodeURIComponent(q)}&language=English&format=${ext}`;
  const $ = cheerio.load(await html(url));
  const rows = [];
  $('table tbody tr, .catalog tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;
    const md5 = ($(tr).find('a[href*="/fiction/"]').attr('href') || '').match(/([A-Fa-f0-9]{32})/)?.[1];
    if (!md5) return;
    const rowTitle = $(tr).find('a[href*="/fiction/"]').first().text().trim();
    const author2 = tds.eq(0).text().trim();
    const fmt = ($(tr).text().match(/\b(epub|pdf|mobi|azw3)\b/i) || [])[1] || ext;
    rows.push({ title: rowTitle, author: author2, md5, ext: fmt.toLowerCase(), source: 'libgen' });
  });
  return rows.slice(0, 10);
}

// Resolve an md5 → a direct, fetchable file URL via the download mirror.
export async function resolveLibgenUrl(md5) {
  for (const path of [`/fiction/${md5}`, `/main/${md5}`]) {
    try {
      const $ = cheerio.load(await html(`${RESOLVE_BASE}${path}`));
      // library.lol puts the primary GET link in #download h2 a (or the first mirror link)
      const href = $('#download a[href]').first().attr('href') || $('a:contains("GET")').first().attr('href');
      if (href && /^https?:\/\//.test(href)) return href;
    } catch {}
  }
  return null;
}

// One-shot: find the best ebook + resolve its direct URL.
export async function findLibgenEbook(title, author) {
  for (const ext of ['epub', 'mobi', 'pdf']) {
    const rows = await searchLibgen(title, author, { ext }).catch(() => []);
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const t = norm(title).split(' ').slice(0, 3).join(' ');
    const best = rows.find(r => norm(r.title).includes(t)) || rows[0];
    if (!best) continue;
    const url = await resolveLibgenUrl(best.md5).catch(() => null);
    if (url) return { source: 'libgen', title: best.title, author: best.author, format: best.ext === 'azw3' ? 'epub' : best.ext, url };
  }
  return null;
}
