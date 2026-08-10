// TorrentLeech — audiobook + ebook search (private tracker, high-seed quality).
// Adapted from Sound's music searcher. TL categories: 45 = Audiobooks, 46 = Ebooks.
// Returns a .torrent buffer (downloaded with the passkey) for the seedbox to add.
const TL_BASE = 'https://www.torrentleech.org';
const TL_USER = process.env.TL_USER    || '';
const TL_PASS = process.env.TL_PASS    || '';
const TL_PK   = process.env.TL_PASSKEY || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const CATS = { audio: '45', ebook: '46' };

let _cookie = null, _loginAt = 0;

async function tlLogin() {
  if (!TL_USER || !TL_PASS) throw new Error('TL creds not set');
  if (_cookie && Date.now() - _loginAt < 3 * 60 * 60 * 1000) return;
  const res = await fetch(`${TL_BASE}/user/account/login/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Referer: `${TL_BASE}/user/account/login/` },
    body: new URLSearchParams({ username: TL_USER, password: TL_PASS }),
    redirect: 'manual',
  });
  const raw = res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') || '').split(/,\s*(?=[A-Za-z_-]+=)/).filter(Boolean);
  const jar = {};
  for (const sc of raw) { const [kv] = sc.split(';'); const eq = kv.indexOf('='); if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim(); }
  if (!jar.PHPSESSID) throw new Error('TorrentLeech login failed');
  _cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  _loginAt = Date.now();
}

async function tlFetch(path, retried = false) {
  await tlLogin();
  const res = await fetch(`${TL_BASE}${path}`, {
    headers: { 'User-Agent': UA, Cookie: _cookie, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, */*' },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!retried && text.includes('Login :: TorrentLeech')) { _cookie = null; return tlFetch(path, true); }
  return text;
}

async function tlBinary(url) {
  await tlLogin();
  const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: _cookie }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`TL download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] !== 0x64) throw new Error('TL returned non-torrent data');
  return buf;
}

const clean = (s) => (s || '').replace(/&/g, 'and').replace(/[''`]/g, '').replace(/[*!?#@$%^+=|<>:{}[\]\\]/g, '').replace(/\s+/g, ' ').trim();

// mediaType: 'audio' | 'ebook'. Returns { source, title, seeds, size, torrentBuf } or null.
export async function searchTorrentLeech(title, author, mediaType = 'audio') {
  const t = clean(title), a = clean(author || '');
  const cat = CATS[mediaType] || CATS.audio;
  const queries = [a ? `${a} ${t}` : t, t, a ? `${t} ${a}` : null].filter(Boolean);

  const audioRe = /\b(mp3|m4b|m4a|aac|flac|audiobook|unabridged|64kbps|128kbps|vbr)\b/i;
  const ebookRe = /\b(epub|mobi|azw3?|pdf|retail|ebook)\b/i;
  const wantRe  = mediaType === 'audio' ? audioRe : ebookRe;
  const titleRe = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+/).slice(0, 5).join('[.\\s_-]+'), 'i');

  for (const q of queries) {
    let results;
    try {
      const text = await tlFetch(`/torrents/browse/list/query/${encodeURIComponent(q)}/categories/${cat}`);
      results = JSON.parse(text)?.torrentList || [];
    } catch { continue; }
    const hits = results.filter(x => titleRe.test(x.name) && (wantRe.test(x.name) || true));
    if (!hits.length) continue;
    hits.sort((x, y) => (y.seeders || 0) - (x.seeders || 0));
    const best = hits[0];
    try {
      const torrentBuf = await tlBinary(`${TL_BASE}/download/${best.fid}/${TL_PK}`);
      return { source: 'torrentleech', title: best.name, seeds: best.seeders || 0, size: best.size || '?', torrentBuf, magnet: null, mediaType };
    } catch { continue; }
  }
  return null;
}
