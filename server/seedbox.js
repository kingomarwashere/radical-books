// Seedbox pipeline for audiobook torrents — add torrent/magnet to qBittorrent,
// wait for download, then stream the audio files over SFTP into R2. Adapted from
// Sound's seedbox.js (shared seedit4.me box); adds magnet support + m4b/audiobook
// extensions. Ebooks do NOT use this (libgen serves files over plain HTTP).
import SftpClient from 'ssh2-sftp-client';
import { createHash } from 'crypto';

const QB_URL    = process.env.SEEDBOX_QB_URL    || 'https://60.ftl31.seedit4.me/qbittorrent';
const QB_USER   = process.env.SEEDBOX_USER      || '';
const QB_PASS   = process.env.SEEDBOX_PASS      || '';
const SFTP_HOST = process.env.SEEDBOX_SFTP_HOST || 'ftl31.seedit4.me';
const SFTP_PORT = parseInt(process.env.SEEDBOX_SFTP_PORT || '2100');

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.opus', '.flac', '.wav']);

// ── Bencode info-hash extractor (for .torrent files) ──────────────────────────
function _bencEnd(buf, pos) {
  const c = buf[pos];
  if (c === 0x64 || c === 0x6c) { pos++; while (pos < buf.length && buf[pos] !== 0x65) pos = _bencEnd(buf, pos); return pos + 1; }
  if (c === 0x69) { const e = buf.indexOf(0x65, pos + 1); return e + 1; }
  if (c >= 0x30 && c <= 0x39) { const colon = buf.indexOf(0x3a, pos); return colon + 1 + parseInt(buf.slice(pos, colon).toString('ascii'), 10); }
  throw new Error(`bencode: unknown 0x${c.toString(16)} at ${pos}`);
}
export function extractInfoHash(buf) {
  const marker = Buffer.from('4:info');
  for (let i = 0; i <= buf.length - marker.length; i++) {
    if (!buf.slice(i, i + marker.length).equals(marker)) continue;
    try { return createHash('sha1').update(buf.slice(i + marker.length, _bencEnd(buf, i + marker.length))).digest('hex'); } catch {}
  }
  return null;
}
function magnetHash(magnet) { return (magnet.match(/btih:([A-Fa-f0-9]{40})/i) || [])[1]?.toLowerCase() || null; }

// ── qBittorrent auth (nginx Basic Auth + qBit SID cookie) ─────────────────────
const QB_BASIC = 'Basic ' + Buffer.from(`${QB_USER}:${QB_PASS}`).toString('base64');
let _sid = null, _sidAt = 0;
async function qbLogin() {
  if (_sid !== null && Date.now() - _sidAt < 2 * 60 * 60 * 1000) return;
  const res = await fetch(`${QB_URL}/api/v2/auth/login`, {
    method: 'POST',
    headers: { Authorization: QB_BASIC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: QB_USER, password: QB_PASS }),
    redirect: 'manual',
  });
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  _sid = raw.map(c => c.split(';')[0]).find(c => c.startsWith('SID=')) || '';
  _sidAt = Date.now();
}
async function qbFetch(path, opts = {}) {
  await qbLogin();
  const headers = { Authorization: QB_BASIC, ...(opts.headers || {}) };
  if (_sid) headers.Cookie = _sid;
  const res = await fetch(`${QB_URL}${path}`, { ...opts, headers });
  if (res.status === 401) { _sid = null; throw new Error('qBittorrent 401'); }
  return res;
}

export async function addTorrent(torrentBuf, savePath) {
  const hash = extractInfoHash(torrentBuf);
  if (!hash) throw new Error('Could not extract torrent hash');
  const form = new FormData();
  form.append('torrents', new Blob([torrentBuf], { type: 'application/x-bittorrent' }), 'b.torrent');
  form.append('savepath', savePath);
  form.append('category', 'books');
  const text = await (await qbFetch('/api/v2/torrents/add', { method: 'POST', body: form })).text();
  if (text.includes('Fails.') && !(await getTorrentInfo(hash))) throw new Error('qBittorrent add failed');
  return hash;
}
export async function addMagnet(magnet, savePath) {
  const hash = magnetHash(magnet);
  const form = new FormData();
  form.append('urls', magnet);
  form.append('savepath', savePath);
  form.append('category', 'books');
  await qbFetch('/api/v2/torrents/add', { method: 'POST', body: form });
  return hash;
}

export async function getTorrentInfo(hash) {
  const list = await (await qbFetch(`/api/v2/torrents/info?hashes=${hash}`)).json();
  return list[0] || null;
}
export async function waitForDownload(hash, onProgress, { timeoutMs = 45 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 5000));
    const info = await getTorrentInfo(hash).catch(() => null);
    if (!info) continue;
    const pct = Math.floor((info.downloaded / (info.size || 1)) * 100);
    onProgress?.(pct, info.state);
    if (['uploading', 'seeding', 'stalledUP', 'pausedUP', 'forcedUP'].includes(info.state)) return info;
    if (['error', 'missingFiles'].includes(info.state)) throw new Error(`Torrent error: ${info.state}`);
  }
  throw new Error('Torrent download timed out');
}

// ── SFTP ──────────────────────────────────────────────────────────────────────
async function _collectAudio(sftp, dir) {
  const items = await sftp.list(dir);
  const results = [];
  for (const item of items) {
    if (item.type === 'd') results.push(...await _collectAudio(sftp, `${dir}/${item.name}`));
    else if (item.type === '-') {
      const ext = item.name.slice(item.name.lastIndexOf('.')).toLowerCase();
      if (AUDIO_EXTS.has(ext)) results.push({ name: item.name, size: item.size, path: `${dir}/${item.name}` });
    }
  }
  return results;
}
export async function listAudioFiles(remotePath) {
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
    const results = await _collectAudio(sftp, remotePath);
    return results.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } finally { await sftp.end().catch(() => {}); }
}
export async function streamFile(remotePath) {
  const sftp = new SftpClient();
  await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
  const stream = sftp.createReadStream(remotePath);
  stream.on('close', () => sftp.end().catch(() => {}));
  stream.on('error', () => sftp.end().catch(() => {}));
  return stream;
}
