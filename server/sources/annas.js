// Anna's Archive — the big aggregator (mirrors LibGen, Z-Library, Sci-Hub, IA).
// Ebook source. The *download* half is Anna's member fast-download JSON API
// (/dyn/api/fast_download.json) which is served cleanly (no JS wall) on the .gl
// mirror and returns a direct, fetchable URL we stream into R2.
//
// The *search* half is the problem: every live Anna's mirror puts its search UI
// behind a JS anti-bot wall (Akamai on .net, FingerprintJS on .li, DDoS-Guard on
// .gl), so a headless scraper can't get md5s from Anna's directly. Instead we
// source md5s from LibGen (which Anna's indexes) and resolve the download through
// Anna's fast member servers — more reliable than LibGen's own mirrors. If a
// direct md5 is ever available (e.g. an unwalled search endpoint), pass it too.
//
//   env: ANNAS_KEY  = secret API key from your Anna's account (Account → key;
//                     needs active membership + fast-download quota).
//        ANNAS_BASE = API mirror (default https://annas-archive.gl — the one that
//                     currently serves the JSON API without a wall).
import { searchLibgen } from './libgen.js';

const ANNAS_BASE = process.env.ANNAS_BASE || 'https://annas-archive.gl';
const ANNAS_KEY  = process.env.ANNAS_KEY || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Member fast-download: md5 → direct file URL. Needs an active membership + quota.
// Returns the URL string, or null if this key/md5 can't be served (out of quota,
// not indexed, etc.).
export async function annasResolve(md5) {
  if (!ANNAS_KEY) return null;
  const res = await fetch(`${ANNAS_BASE}/dyn/api/fast_download.json?md5=${md5}&key=${ANNAS_KEY}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (json?.download_url) return json.download_url;
  return null; // json.error carries the reason (bad key / no quota / not found)
}

// Collect candidate md5s for a title. Primary: LibGen search (Anna's indexes it).
async function candidateMd5s(title, author) {
  const out = [];
  const t = norm(title).split(' ').slice(0, 3).join(' ');
  for (const ext of ['epub', 'mobi', 'azw3', 'pdf']) {
    const rows = await searchLibgen(title, author, { ext }).catch(() => []);
    const ranked = rows.filter(r => norm(r.title).includes(t)).concat(rows);
    for (const r of ranked) if (r.md5 && !out.find(o => o.md5 === r.md5)) out.push({ md5: r.md5, ext: r.ext === 'azw3' ? 'epub' : r.ext, title: r.title });
    if (out.length >= 6) break;
  }
  return out.slice(0, 6);
}

// One-shot: find the best ebook + resolve a direct URL via Anna's member API.
// Returns {source,title,format,url} or null.
export async function findAnnasEbook(title, author) {
  if (!ANNAS_KEY) return null;
  const candidates = await candidateMd5s(title, author);
  for (const c of candidates) {
    let url; try { url = await annasResolve(c.md5); } catch { continue; }
    if (url) return { source: 'annas', title: c.title || title, format: c.ext || 'epub', url };
  }
  return null;
}
