// Bulk catalog seeder. Pulls popular public-domain titles from LibriVox
// (audiobooks) and Project Gutenberg (ebooks) and ingests them directly
// (synchronously, not via the queue) so a fresh DB gets a browsable catalog.
//
//   node run-catalog.mjs [audioPages] [ebookPages]
import './server/net.js';
import 'dotenv/config';
import { browseLibriVox } from './server/sources/librivox.js';
import { browseGutenberg } from './server/sources/gutenberg.js';
import { ingestAudiobook, ingestEbook } from './server/ingest.js';

const audioCount = parseInt(process.argv[2] || '20', 10);   // # audiobooks
const ebookPages = parseInt(process.argv[3] || '2', 10);    // Gutendex pages (~32 each)

async function seedAudiobooks() {
  let done = 0, offset = 0;
  while (done < audioCount) {
    const batch = await browseLibriVox({ limit: 20, offset });
    if (!batch.length) break;
    offset += batch.length;
    for (const d of batch) {
      if (done >= audioCount) break;
      try {
        const b = await ingestAudiobook(d);
        console.log(`[audio] ✓ ${b.title} — ${b.author_name} (${d.chapters.length} ch)`);
        done++;
      } catch (e) { console.warn(`[audio] ✗ ${d.title}: ${e.message}`); }
    }
  }
  console.log(`[audio] seeded ${done} audiobooks`);
}

async function seedEbooks() {
  let done = 0;
  for (let page = 1; page <= ebookPages; page++) {
    const batch = await browseGutenberg({ page });
    for (const d of batch) {
      try {
        const b = await ingestEbook(d);
        console.log(`[ebook] ✓ ${b.title} — ${b.author_name}`);
        done++;
      } catch (e) { console.warn(`[ebook] ✗ ${d.title}: ${e.message}`); }
    }
  }
  console.log(`[ebook] seeded ${done} ebooks`);
}

await seedAudiobooks();
await seedEbooks();
console.log('[catalog] seeding complete');
process.exit(0);
