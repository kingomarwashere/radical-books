// Internet Archive — the primary MODERN source (libgen/Anna's are down). IA hosts
// user-uploaded audiobooks (direct MP3s) and ebooks (epub/pdf), searchable via a
// clean JSON API with directly-downloadable files (no torrent/seedbox). Covers
// current bestsellers that Gutenberg/LibriVox (public-domain only) don't have.
const UA = 'RadicalBooks/1.0 (+https://books.theradicalparty.com)';
const AUDIO_EXT = /\.(mp3|m4a|m4b|ogg)$/i;

function j(url) {
  return fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`IA HTTP ${r.status}`)));
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Junk we don't want when a real copy exists (summaries, translations, workbooks…).
const JUNK = /\b(summary|review|workbook|analysis|study guide|in hindi|hindi|urdu|telugu|tamil|espa|fran|deutsch|podcast|interview|excerpt|sample|trailer)\b/i;

function titleOk(candidate, want) {
  const c = norm(candidate), w = norm(want);
  if (!c || !w) return false;
  const key = w.split(' ').slice(0, 4).join(' ');
  return c.includes(key);
}

async function search(query, mediatype, rows = 20) {
  const q = `${query} AND mediatype:${mediatype}`;
  const url = `https://archive.org/advancedsearch.php?${new URLSearchParams({ q })}` +
    `&fl[]=identifier&fl[]=title&fl[]=downloads&sort[]=downloads+desc&rows=${rows}&output=json`;
  const data = await j(url).catch(() => null);
  return data?.response?.docs || [];
}

function dlUrl(identifier, name) {
  return `https://archive.org/download/${identifier}/${name.split('/').map(encodeURIComponent).join('/')}`;
}

// ── Modern audiobook: pick the item with the most total audio, matching the title ──
export async function searchArchiveAudio(title, author, { minMinutes = 45 } = {}) {
  const docs = await search(`title:(${title})`, 'audio', 20);
  const ranked = docs.filter(d => titleOk(d.title, title)).sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  // Fetch metadata for the top candidates, prefer the longest, non-junk one.
  let best = null;
  for (const d of ranked.slice(0, 8)) {
    const m = await j(`https://archive.org/metadata/${d.identifier}`).catch(() => null);
    if (!m || m.metadata?.['access-restricted-item']) continue;
    const files = (m.files || []).filter(f => AUDIO_EXT.test(f.name || ''))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
    if (!files.length) continue;
    const totalSec = files.reduce((s, f) => s + (parseFloat(f.length) || 0), 0);
    const mins = totalSec / 60;
    const junk = JUNK.test(d.title || '');
    if (mins < minMinutes) continue;
    const cand = { identifier: d.identifier, title: d.title, mins, junk, files, totalSec };
    if (!best || (best.junk && !junk) || (junk === best.junk && mins > best.mins)) best = cand;
    if (best && !best.junk && best.mins > 120) break; // good enough (full book)
  }
  if (!best) return null;
  return {
    source: 'archive', mediaType: 'audio', identifier: best.identifier, title: best.title,
    runtime: Math.round(best.totalSec),
    chapters: best.files.map((f, i) => ({
      idx: i,
      title: (f.title || f.name.replace(/\.[^.]+$/, '').replace(/^.*?[-_]/, '')).slice(0, 120) || `Part ${i + 1}`,
      duration: parseFloat(f.length) ? Math.round(parseFloat(f.length)) : null,
      url: dlUrl(best.identifier, f.name),
    })),
  };
}

// ── Modern ebook: prefer epub, fall back to pdf; skip lending-restricted items ──
export async function searchArchiveEbook(title, author) {
  const docs = await search(`title:(${title})`, 'texts', 20);
  const ranked = docs.filter(d => titleOk(d.title, title))
    .sort((a, b) => (JUNK.test(a.title || '') - JUNK.test(b.title || '')) || (b.downloads || 0) - (a.downloads || 0));
  for (const d of ranked.slice(0, 10)) {
    const m = await j(`https://archive.org/metadata/${d.identifier}`).catch(() => null);
    if (!m || m.metadata?.['access-restricted-item']) continue;
    const files = m.files || [];
    const epub = files.find(f => /\.epub$/i.test(f.name || ''));
    const pdf = files.find(f => /\.pdf$/i.test(f.name || ''));
    const pick = epub || pdf;
    if (!pick) continue;
    return {
      source: 'archive', mediaType: 'ebook', identifier: d.identifier, title: d.title,
      format: epub ? 'epub' : 'pdf',
      url: dlUrl(d.identifier, pick.name),
    };
  }
  return null;
}
