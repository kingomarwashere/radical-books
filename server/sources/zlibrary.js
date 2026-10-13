// Z-Library — ebook source. Logs in with your account to get the remix session
// cookies, searches the catalog, and returns the authenticated /dl/ URL (plus the
// Cookie header) so the file streams straight into R2.
//
// AUTH (primary): ZLIB_USERID + ZLIB_USERKEY — the `remix_userid` / `remix_userkey`
//   cookies from a logged-in browser session. This is the reliable path: current
//   Z-Library uses a JS SPA + per-user "personal domain", so a headless
//   email/password POST no longer returns a session on the public mirrors.
// AUTH (fallback): ZLIB_EMAIL + ZLIB_PASS via rpc.php — kept as best-effort; will
//   simply no-op if the mirror doesn't honour it.
//   env: ZLIB_BASE = your personal domain or a working mirror (default
//        https://zlibrary-global.se). Update when it moves. Anna's Archive mirrors
//        the same collection and is the more stable path.
import * as cheerio from 'cheerio';

const ZLIB_BASE   = process.env.ZLIB_BASE   || 'https://zlibrary-global.se';
const ZLIB_LOGIN  = process.env.ZLIB_LOGIN  || ZLIB_BASE;
const ZLIB_EMAIL  = process.env.ZLIB_EMAIL  || '';
const ZLIB_PASS   = process.env.ZLIB_PASS   || '';
const ZLIB_USERID  = process.env.ZLIB_USERID  || '';
const ZLIB_USERKEY = process.env.ZLIB_USERKEY || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hasCreds = () => (ZLIB_USERID && ZLIB_USERKEY) || (ZLIB_EMAIL && ZLIB_PASS);

let _cookie = null, _loginAt = 0;

async function zlibLogin() {
  // Preferred: use browser session cookies directly.
  if (ZLIB_USERID && ZLIB_USERKEY) { _cookie = `remix_userid=${ZLIB_USERID}; remix_userkey=${ZLIB_USERKEY}`; return _cookie; }
  if (!ZLIB_EMAIL || !ZLIB_PASS) throw new Error('Z-Library creds not set');
  if (_cookie && Date.now() - _loginAt < 6 * 60 * 60 * 1000) return _cookie;
  const res = await fetch(`${ZLIB_LOGIN}/rpc.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ isModal: 'true', email: ZLIB_EMAIL, password: ZLIB_PASS, site_mode: 'books', action: 'login', gg_json_mode: '1' }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  const r = json?.response || {};
  const uid = r.user_id || r.userId, key = r.user_key || r.userKey;
  if (!uid || !key) throw new Error(`Z-Library login failed (mirror needs browser-session cookies — set ZLIB_USERID/ZLIB_USERKEY): ${r.message || json?.errors?.[0]?.message || 'no session'}`);
  _cookie = `remix_userid=${uid}; remix_userkey=${key}`;
  _loginAt = Date.now();
  return _cookie;
}

async function zlibSearch(title, author, ext) {
  const cookie = await zlibLogin();
  const q = [author, title].filter(Boolean).join(' ');
  const url = `${ZLIB_BASE}/s/${encodeURIComponent(q)}?extensions%5B%5D=${ext.toUpperCase()}&languages%5B%5D=english`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookie, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`zlib search HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const out = [];
  $('z-bookcard').each((_, el) => {
    const dl = $(el).attr('download');           // e.g. /dl/12345/abcdef
    if (!dl) return;
    const t = $(el).find('[slot="title"]').text().trim() || $(el).attr('title') || '';
    out.push({ title: t, dl, ext: ($(el).attr('extension') || ext).toLowerCase() });
  });
  return out.slice(0, 12);
}

// One-shot: find the best ebook + authenticated URL. Returns {source,title,format,url,headers} or null.
export async function findZlibEbook(title, author) {
  if (!hasCreds()) return null;
  const t = norm(title).split(' ').slice(0, 3).join(' ');
  let cookie; try { cookie = await zlibLogin(); } catch { return null; }
  for (const ext of ['epub', 'mobi', 'azw3', 'pdf']) {
    let rows;
    try { rows = await zlibSearch(title, author, ext); } catch { continue; }
    const best = rows.find(r => norm(r.title).includes(t)) || rows[0];
    if (!best) continue;
    const fmt = best.ext === 'azw3' ? 'epub' : best.ext;
    return { source: 'zlibrary', title: best.title, format: fmt, url: `${ZLIB_BASE}${best.dl}`, headers: { Cookie: cookie } };
  }
  return null;
}
