// AudioBookBay — public audiobook tracker. Domain-hops frequently, so the base
// URL is configurable (ABB_BASE). Each result page exposes an info-hash + trackers
// we assemble into a magnet link (ABB rarely serves .torrent files directly).
import * as cheerio from 'cheerio';

const BASE = process.env.ABB_BASE || 'https://audiobookbay.lu';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

async function html(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`ABB HTTP ${res.status}`);
  return res.text();
}

// Search → list of {title, detailUrl}.
export async function searchAudiobookBay(query) {
  const url = `${BASE}/?s=${encodeURIComponent(query)}`;
  const $ = cheerio.load(await html(url));
  const out = [];
  $('.post').each((_, el) => {
    const a = $(el).find('.postTitle h2 a, h2 a').first();
    const title = a.text().trim();
    const href = a.attr('href');
    if (title && href) out.push({ source: 'audiobookbay', title, detailUrl: href.startsWith('http') ? href : `${BASE}${href}` });
  });
  return out.slice(0, 12);
}

// Resolve a detail page → magnet link (built from the info-hash ABB lists).
export async function getAudiobookBayMagnet(detailUrl, title = 'audiobook') {
  const page = await html(detailUrl);
  // ABB shows the info hash in a table row: "Info Hash: <40 hex>"
  const m = page.match(/Info Hash:?\s*<\/td>\s*<td[^>]*>\s*([A-Fa-f0-9]{40})/) || page.match(/([A-Fa-f0-9]{40})/);
  if (!m) {
    // Some skins embed a magnet directly.
    const mag = page.match(/magnet:\?xt=urn:btih:[^"'\s]+/);
    return mag ? mag[0] : null;
  }
  const hash = m[1].toLowerCase();
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${TRACKERS}`;
}

// One-shot: search + resolve the top hit to a magnet.
export async function findAudiobookBay(title, author) {
  const q = [author, title].filter(Boolean).join(' ');
  const results = await searchAudiobookBay(q).catch(() => []);
  if (!results.length) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const t = norm(title);
  const best = results.find(r => norm(r.title).includes(t.split(' ').slice(0, 3).join(' '))) || results[0];
  const magnet = await getAudiobookBayMagnet(best.detailUrl, best.title).catch(() => null);
  return magnet ? { source: 'audiobookbay', title: best.title, magnet, torrentBuf: null, mediaType: 'audio' } : null;
}
