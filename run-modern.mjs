// Acquire popular MODERN / recent books from Internet Archive (ebook + audiobook)
// and feature them above the classics so the homepage leads with recent titles.
//   node run-modern.mjs
import './server/net.js';
import 'dotenv/config';
import { MODERN } from './server/curated.js';
import { acquireEbook, acquireAudiobook } from './server/ingest.js';
import { setPopularity } from './server/catalog.js';

const BASE = 6_000_000; // above curated classics (5M) so modern leads "Popular right now"
let ne = 0, na = 0;

for (let i = 0; i < MODERN.length; i++) {
  const m = MODERN[i];
  const meta = { plainTitle: m.title, title: m.title, authorName: m.author, source: 'openlibrary' };
  const score = BASE - i * 1000;
  try { const b = await acquireEbook(meta);     setPopularity(b.id, { popularity: score, featured: true }); ne++; console.log(`[ebook] ✓ ${m.title}`); }
  catch (e) { console.log(`[ebook] ✗ ${m.title}: ${e.message}`); }
  try { const b = await acquireAudiobook(meta); setPopularity(b.id, { popularity: score, featured: true }); na++; console.log(`[audio] ✓ ${m.title}`); }
  catch (e) { console.log(`[audio] ✗ ${m.title}: ${e.message}`); }
}

console.log(`\nModern acquired: ${ne} ebooks, ${na} audiobooks (from Internet Archive).`);
process.exit(0);
