// R2 storage. Reuses the shared Radical R2 worker + CDN (cdn.theradicalparty.com,
// bucket radical-movies-storage) with a `books/` key prefix, so no new bucket or
// worker is required. Same multipart-upload protocol as Sound/Movies.
const UPLOAD_URL    = process.env.R2_UPLOAD_URL || 'https://radical-movies-r2.omar-c29.workers.dev';
const CDN_URL       = process.env.R2_CDN_URL    || 'https://cdn.theradicalparty.com';
const UPLOAD_SECRET = process.env.R2_UPLOAD_SECRET || '';

const MIME = {
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',
  '.m4b':  'audio/mp4',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav':  'audio/wav',
  '.epub': 'application/epub+zip',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8',
};

const PART_SIZE   = 8 * 1024 * 1024;   // 8 MB
const CONCURRENCY = 3;

export function getStreamUrl(key) {
  return `${CDN_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export function mimeFor(ext) { return MIME[(ext || '').toLowerCase()] || 'application/octet-stream'; }

// Multipart-stream a Node Readable straight into R2. onProgress(pct) optional.
export async function uploadStreamToR2(readable, totalSize, key, ext, onProgress) {
  const contentType = mimeFor(ext);
  const headers     = { 'x-upload-secret': UPLOAD_SECRET };
  const mkUrl       = (p) => `${UPLOAD_URL}/upload?${new URLSearchParams({ key, ...p })}`;

  const createRes = await fetch(mkUrl({ action: 'create', contentType }), { method: 'POST', headers });
  if (!createRes.ok) throw new Error(`R2 create: ${createRes.status} ${await createRes.text()}`);
  const { uploadId } = await createRes.json();

  const collected = [];
  const inFlight  = [];
  let partNum = 0, uploaded = 0, buf = Buffer.alloc(0);

  function startPart(chunk) {
    const pNum = ++partNum;
    return (async () => {
      const res = await fetch(mkUrl({ action: 'part', uploadId, partNumber: String(pNum) }), {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: chunk,
      });
      if (!res.ok) throw new Error(`R2 part ${pNum}: ${res.status}`);
      const { etag } = await res.json();
      uploaded += chunk.length;
      if (totalSize) onProgress?.(Math.min(99, Math.floor(uploaded / totalSize * 100)));
      return { partNumber: pNum, etag };
    })();
  }

  try {
    for await (const chunk of readable) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      while (buf.length >= PART_SIZE) {
        if (inFlight.length >= CONCURRENCY) collected.push(await inFlight.shift());
        inFlight.push(startPart(Buffer.from(buf.slice(0, PART_SIZE))));
        buf = buf.slice(PART_SIZE);
      }
    }
    if (buf.length) {
      if (inFlight.length >= CONCURRENCY) collected.push(await inFlight.shift());
      inFlight.push(startPart(buf));
    }
    for (const p of inFlight) collected.push(await p);
    collected.sort((a, b) => a.partNumber - b.partNumber);

    const completeRes = await fetch(mkUrl({ action: 'complete', uploadId }), {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ parts: collected }),
    });
    if (!completeRes.ok) throw new Error(`R2 complete: ${completeRes.status} ${await completeRes.text()}`);
    return key;
  } catch (err) {
    await fetch(mkUrl({ action: 'abort', uploadId }), { method: 'DELETE', headers }).catch(() => {});
    throw err;
  }
}

// Fetch a remote URL and stream it straight into R2 (no local disk).
export async function uploadUrlToR2(url, key, ext, onProgress) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'RadicalBooks/1.0 (+https://books.theradicalparty.com)' },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok || !res.body) throw new Error(`fetch ${url} → ${res.status}`);
  const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
  await uploadStreamToR2(res.body, total, key, ext, onProgress);
  return { key, size: total };
}
