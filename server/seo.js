// SEO surface: robots.txt, a dynamic sitemap of every book, and server-rendered
// book landing pages (crawlable, with OG + JSON-LD) that hydrate into the SPA.
// No playable/readable URLs are exposed here — browse metadata only.
import { listBooks, getBook, getBookBySlug, toBookClient } from './catalog.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = process.env.SITE_URL || 'https://books.theradicalparty.com';
const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');
const esc = (s) => String(s || '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

export function seoRoutes(app) {
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  });

  app.get('/sitemap.xml', (_req, res) => {
    const books = listBooks({ limit: 5000 });
    const urls = [
      `${SITE}/`, `${SITE}/audiobooks`, `${SITE}/ebooks`,
      ...books.map(b => `${SITE}/book/${b.slug}`),
    ];
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map(u => `  <url><loc>${esc(u)}</loc></url>`).join('\n') +
      `\n</urlset>\n`);
  });

  // Book landing page: serve the real SPA shell (so the app hydrates normally) but
  // with crawler/unfurl meta + JSON-LD injected into <head>. Wrong slug → 301 canonical.
  app.get('/book/:slug', (req, res, next) => {
    const b = getBookBySlug(req.params.slug) || getBook(req.params.slug);
    if (!b) return next();
    if (b.slug && b.slug !== req.params.slug) return res.redirect(301, `/book/${b.slug}`);
    const book = toBookClient(b);
    const types = [book.hasAudio && 'Audiobook', book.hasEbook && 'Ebook'].filter(Boolean).join(' + ');
    const desc = (book.description || `${book.title} by ${book.author} — free ${types.toLowerCase()} on Radical Books.`).replace(/\s+/g, ' ').slice(0, 300);
    const ld = {
      '@context': 'https://schema.org', '@type': 'Book', name: book.title,
      author: { '@type': 'Person', name: book.author }, image: book.cover, inLanguage: book.language,
      ...(book.year ? { datePublished: String(book.year) } : {}),
    };
    let html;
    try { html = fs.readFileSync(INDEX_HTML, 'utf8'); } catch { return next(); }
    const head = `<title>${esc(book.title)} — ${esc(book.author)} · Radical Books</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}/book/${esc(book.slug)}">
<meta property="og:type" content="book"><meta property="og:title" content="${esc(book.title)} — ${esc(book.author)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(book.cover || '')}">
<meta property="og:url" content="${SITE}/book/${esc(book.slug)}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
    // Replace the default <title>…</title> and inject the rest just before </head>.
    html = html.replace(/<title>[\s\S]*?<\/title>/, head).replace('</head>', '</head>');
    res.type('html').set('Cache-Control', 'no-store').send(html);
  });
}
