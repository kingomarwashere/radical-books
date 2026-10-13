// MyAnonaMouse (MAM) — audiobook + ebook search on the private tracker.
// Uses MAM's JSON search API (loadSearchJSONbasic.php) and a single session
// cookie (mam_id) for auth. Downloads a passkey-embedded .torrent for the
// seedbox to add — same return shape as searchTorrentLeech.
//
//   env: MAM_ID = the mam_id session string from Preferences → Security.
//   NOTE: MAM sessions can be locked to the IP/ASN they were created on. Create
//   the session from (or unlock it for) the VM/seedbox that runs this code, or
//   downloads will 403.
const MAM_BASE = process.env.MAM_BASE || 'https://www.myanonamouse.net';
const MAM_ID   = process.env.MAM_ID || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// MAM main categories.  13 = Audiobooks, 14 = E-Books.
const MAIN_CAT = { audio: 13, ebook: 14 };

const clean = (s) => (s || '').replace(/&/g, 'and').replace(/[''`]/g, '').replace(/[*!?#@$%^+=|<>:{}[\]\\]/g, '').replace(/\s+/g, ' ').trim();
const decode = (s) => (s || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '').trim();

function authorFrom(info) {
  try { const o = typeof info === 'string' ? JSON.parse(info) : info; return Object.values(o || {})[0] || ''; }
  catch { return ''; }
}

async function mamSearch(query, mediaType) {
  const body = {
    tor: {
      text: query,
      srchIn: { title: 'true', author: 'true' },
      searchType: 'all',
      searchIn: 'torrents',
      main_cat: [MAIN_CAT[mediaType] || MAIN_CAT.audio],
      browseFlagsHideVsShow: '0',
      sortType: 'seedersDesc',
      startNumber: '0',
    },
    perpage: 25,
    thumbnail: 'false',
  };
  const res = await fetch(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Cookie: `mam_id=${MAM_ID}`, Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (text.includes('Login') && !text.trim().startsWith('{')) throw new Error('MAM session invalid (mam_id expired or IP-locked)');
  let json; try { json = JSON.parse(text); } catch { throw new Error('MAM returned non-JSON'); }
  return Array.isArray(json?.data) ? json.data : [];
}

async function mamTorrent(dl) {
  const res = await fetch(`${MAM_BASE}/tor/download.php/${dl}`, {
    headers: { 'User-Agent': UA, Cookie: `mam_id=${MAM_ID}` },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`MAM download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] !== 0x64) throw new Error('MAM returned non-torrent data'); // bencoded .torrent starts with 'd'
  return buf;
}

// mediaType: 'audio' | 'ebook'. Returns { source, title, author, seeds, size, torrentBuf, magnet, mediaType } or null.
export async function searchMyAnonaMouse(title, author, mediaType = 'audio') {
  if (!MAM_ID) return null;
  const t = clean(title), a = clean(author || '');
  const queries = [a ? `${a} ${t}` : t, t].filter(Boolean);
  const titleRe = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+/).slice(0, 5).join('[.\\s_:-]+'), 'i');

  for (const q of queries) {
    let rows;
    try { rows = await mamSearch(q, mediaType); } catch { continue; }
    const hits = rows
      .map(r => ({ ...r, _title: decode(r.title) }))
      .filter(r => titleRe.test(r._title));
    if (!hits.length) continue;
    hits.sort((x, y) => (y.seeders || 0) - (x.seeders || 0));
    const best = hits[0];
    try {
      const torrentBuf = await mamTorrent(best.dl);
      return {
        source: 'myanonamouse',
        title: best._title,
        author: authorFrom(best.author_info),
        seeds: best.seeders || 0,
        size: best.size || '?',
        torrentBuf,
        magnet: null,
        mediaType,
      };
    } catch { continue; }
  }
  return null;
}
