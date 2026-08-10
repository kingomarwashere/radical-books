// books-proxy — Cloudflare Worker fronting books.theradicalparty.com → the VM
// origin (books-origin.theradicalparty.com → :3030). Mirrors the sound-proxy:
// images/fonts are edge-cached; everything else (API/HTML/JS/CSS) is no-store so
// deploys go live instantly.
const ORIGIN = 'http://books-origin.theradicalparty.com';
const ORIGIN_HOST = 'books-origin.theradicalparty.com';
const LONG_CACHE_RE = /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf)$/i; // immutable-ish → 1 day
const MED_CACHE_RE  = /\.(js|css)$/i;                                          // versioned/short-lived → 5 min

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const longCache = LONG_CACHE_RE.test(url.pathname);
    const medCache  = MED_CACHE_RE.test(url.pathname);
    const cacheable = longCache || medCache;
    const sep = url.search ? '&' : '?';
    const target = ORIGIN + url.pathname + url.search + (cacheable ? '' : `${sep}_cb=${Date.now()}`);

    const fwd = new Headers(request.headers);
    fwd.set('host', ORIGIN_HOST);
    fwd.set('x-forwarded-for', request.headers.get('cf-connecting-ip') || '');
    fwd.set('x-forwarded-proto', 'https');
    fwd.delete('cf-connecting-ip'); fwd.delete('cf-ipcountry'); fwd.delete('cf-ray'); fwd.delete('cf-visitor');
    fwd.delete('accept-encoding');

    const resp = await fetch(target, {
      method: request.method,
      headers: fwd,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
      cf: cacheable ? { cacheEverything: true, cacheTtl: longCache ? 86400 : 300 } : { cacheEverything: false, cacheTtl: 0 },
    });

    const h = new Headers(resp.headers);
    if (longCache) {
      h.set('Cache-Control', 'public, max-age=86400');
    } else if (medCache) {
      h.set('Cache-Control', 'public, max-age=300');            // JS/CSS: fast repeat loads, deploys live in ≤5 min
      h.delete('Cloudflare-CDN-Cache-Control');
    } else {
      h.set('Cache-Control', 'no-store');
      h.set('Cloudflare-CDN-Cache-Control', 'no-store');
    }
    if ((resp.headers.get('content-type') || '').includes('text/html')) {
      h.delete('content-encoding'); h.delete('content-length');
    }
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
  },
};
