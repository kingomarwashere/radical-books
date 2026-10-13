// Bibliotik (Bib) — private ebook/audiobook tracker. No JSON API, so we log in
// (or reuse a session cookie), scrape the browse page, and download the passkey-
// embedded .torrent for the seedbox. Same return shape as searchTorrentLeech.
//
//   env: BIB_USER + BIB_PASS  (login), OR BIB_SESSION (a `session` cookie value).
//        BIB_BASE = tracker host (default https://bibliotik.me).
//
// NOTE: Bib is invite-only; you need a member account. HTML/selectors here are
// best-effort and may need a tweak once we can inspect a live page with a session.
import * as cheerio from 'cheerio';

const BIB_BASE    = process.env.BIB_BASE    || 'https://bibliotik.me';
const BIB_USER    = process.env.BIB_USER    || '';
const BIB_PASS    = process.env.BIB_PASS    || '';
const BIB_SESSION = process.env.BIB_SESSION || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Bib categories (the `cat[]` browse filter). Ebooks vs Audiobooks.
const CATS = { ebook: '1', audio: '10' };

const clean = (s) => (s || '').replace(/&/g, 'and').replace(/[''`]/g, '').replace(/[*!?#@$%^+=|<>:{}[\]\\]/g, '').replace(/\s+/g, ' ').trim();

let _cookie = null, _loginAt = 0;

function cookieFromSetCookie(res) {
  const raw = res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') || '').split(/,\s*(?=[A-Za-z_-]+=)/).filter(Boolean);
  const jar = {};
  for (const sc of raw) { const [kv] = sc.split(';'); const eq = kv.indexOf('='); if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim(); }
  return jar;
}

async function bibLogin() {
  if (BIB_SESSION) { _cookie = `session=${BIB_SESSION}`; return _cookie; }
  if (!BIB_USER || !BIB_PASS) throw new Error('Bibliotik creds not set');
  if (_cookie && Date.now() - _loginAt < 6 * 60 * 60 * 1000) return _cookie;
  const res = await fetch(`${BIB_BASE}/login/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Referer: `${BIB_BASE}/login/` },
    body: new URLSearchParams({ username: BIB_USER, password: BIB_PASS, keeplogged: '1', login: 'Log in!' }),
    redirect: 'manual',
  });
  const jar = cookieFromSetCookie(res);
  if (!jar.session) throw new Error('Bibliotik login failed');
  _cookie = `session=${jar.session}`;
  _loginAt = Date.now();
  return _cookie;
}

async function bibFetch(path, retried = false) {
  const cookie = await bibLogin();
  const res = await fetch(`${BIB_BASE}${path}`, {
    headers: { 'User-Agent': UA, Cookie: cookie, Accept: 'text/html' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!retried && !BIB_SESSION && /name=["']password["']/i.test(text)) { _cookie = null; return bibFetch(path, true); }
  return text;
}

async function bibTorrent(id) {
  const cookie = await bibLogin();
  const res = await fetch(`${BIB_BASE}/torrent/${id}/download`, {
    headers: { 'User-Agent': UA, Cookie: cookie },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Bib download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] !== 0x64) throw new Error('Bib returned non-torrent data');
  return buf;
}

// mediaType: 'audio' | 'ebook'. Returns { source, title, seeds, size, torrentBuf, magnet, mediaType } or null.
export async function searchBibliotik(title, author, mediaType = 'ebook') {
  if (!BIB_USER && !BIB_SESSION) return null;
  const t = clean(title), a = clean(author || '');
  const cat = CATS[mediaType] || CATS.ebook;
  const queries = [a ? `${a} ${t}` : t, t].filter(Boolean);
  const titleRe = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+/).slice(0, 5).join('[.\\s_:-]+'), 'i');

  for (const q of queries) {
    let html;
    try { html = await bibFetch(`/torrents/?search=${encodeURIComponent(q)}&cat%5B%5D=${cat}&orderby=seeders&order=desc`); }
    catch { continue; }
    const $ = cheerio.load(html);
    const rows = [];
    $('a[href^="/torrent/"]').each((_, a2) => {
      const href = $(a2).attr('href') || '';
      const id = href.match(/^\/torrent\/(\d+)(?:$|\/|\?)/)?.[1];
      if (!id || /\/download/.test(href)) return;
      const rowTitle = $(a2).text().trim();
      if (!rowTitle) return;
      // seeders/size live in the surrounding row; grab best-effort from the closest <tr>.
      const rowText = $(a2).closest('tr').text();
      const seeds = parseInt((rowText.match(/(\d+)\s*(?:seed|▲)/i) || [])[1] || '0', 10);
      const size = (rowText.match(/([\d.]+\s?(?:KB|MB|GB|GiB|MiB|KiB))/i) || [])[1] || '?';
      rows.push({ id, title: rowTitle, seeds, size });
    });
    const hits = rows.filter(r => titleRe.test(r.title));
    if (!hits.length) continue;
    hits.sort((x, y) => (y.seeds || 0) - (x.seeds || 0));
    const best = hits[0];
    try {
      const torrentBuf = await bibTorrent(best.id);
      return { source: 'bibliotik', title: best.title, seeds: best.seeds || 0, size: best.size, torrentBuf, magnet: null, mediaType };
    } catch { continue; }
  }
  return null;
}
