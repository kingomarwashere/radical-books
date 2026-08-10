// Populate + feature the "popular" catalog so the homepage shows recognizable
// books instead of obscure archive rows.
//   node run-popular.mjs [audioCount]   (default: LibriVox audio for top 16 curated)
//
// 1. Ingest every curated famous EBOOK by Gutenberg id (reliable) → featured + high popularity.
// 2. Add LibriVox AUDIO for the most famous N (so "Popular audiobooks" has real titles).
// 3. Best-effort: fetch popular MODERN audiobooks via torrents (genuinely recent).
import './server/net.js';
import 'dotenv/config';
import { CURATED } from './server/curated.js';
import { ingestEbook, acquireAudiobook } from './server/ingest.js';
import { setPopularity, findBookByTitleAuthor } from './server/catalog.js';

const audioCount = parseInt(process.argv[2] || '16', 10);
const BASE = 5_000_000;

let eb = 0, au = 0;

// 1 + 2: curated famous public-domain books
for (let i = 0; i < CURATED.length; i++) {
  const c = CURATED[i];
  const score = BASE - i * 1000;
  try {
    const book = await ingestEbook({ sourceId: String(c.gid) });
    setPopularity(book.id, { popularity: score, featured: true });
    eb++;
    console.log(`[ebook] ✓ ${c.title}`);
  } catch (e) { console.warn(`[ebook] ✗ ${c.title}: ${e.message}`); }

  // Boost an already-present audiobook of the same work, if any.
  const existing = findBookByTitleAuthor(c.title, c.author);
  if (existing?.has_audio) setPopularity(existing.id, { popularity: score, featured: true });

  if (i < audioCount) {
    try {
      const b = await acquireAudiobook({ plainTitle: c.title, title: c.title, authorName: c.author, source: 'gutenberg' });
      setPopularity(b.id, { popularity: score, featured: true });
      au++;
      console.log(`[audio]  ✓ ${c.title}`);
    } catch (e) { console.warn(`[audio]  ✗ ${c.title}: ${e.message}`); }
  }
}

console.log(`\nDone: ${eb} curated ebooks, ${au} curated audiobooks featured. (Run run-modern.mjs for recent bestsellers.)`);
process.exit(0);
