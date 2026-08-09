// Promo-offer generator ("generate links"), password-gated by GEN_KEY (x-gen-key
// header). Each offer mints {SITE_URL}/upgrade?offer=CODE granting N free days
// then a custom monthly price. Mirrors Sound / Radical Movies.
import { createOffer, listOffers, getOffer, setOfferActive, deleteOffer } from './catalog.js';
import { validateOffer } from './billing.js';

const SITE_URL = process.env.SITE_URL || 'https://books.theradicalparty.com';
const GEN_KEY  = process.env.GEN_KEY;
if (!GEN_KEY) console.warn('[warn] GEN_KEY not set — /generatelinks is disabled until it is.');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode(n = 7) { let s = ''; for (let i = 0; i < n; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]; return s; }
function linkFor(code) { return `${SITE_URL}/upgrade?offer=${encodeURIComponent(code)}`; }

function toClient(o) {
  return { code: o.code, freeDays: o.free_days || 0, monthlyAmount: o.monthly_amount, notes: o.notes || null,
    maxUses: o.max_uses ?? null, uses: o.uses || 0, active: o.active === 1, createdAt: o.created_at, link: linkFor(o.code) };
}

export function offerRoutes(app) {
  function requireGenKey(req, res, next) {
    if (GEN_KEY && req.headers['x-gen-key'] === GEN_KEY) return next();
    return res.status(403).json({ error: 'Forbidden' });
  }

  app.post('/api/generatelinks/offers', requireGenKey, (req, res) => {
    const { freeDays, monthlyAmount, code, maxUses, notes } = req.body || {};
    const amount = parseInt(monthlyAmount, 10);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'monthlyAmount (cents) required' });
    const days = Math.max(0, Math.floor(Number(freeDays) || 0));
    const max = maxUses ? Math.max(1, parseInt(maxUses, 10)) : null;
    let finalCode = (code || '').trim().toUpperCase() || genCode();
    if (!/^[A-Z0-9]{3,16}$/.test(finalCode)) return res.status(400).json({ error: 'Code must be 3–16 letters/numbers' });
    if (getOffer(finalCode)) return res.status(409).json({ error: 'Code already exists' });
    const offer = createOffer({ code: finalCode, freeDays: days, monthlyAmount: amount, notes: notes?.trim() || null, maxUses: max });
    res.json({ ok: true, offer: toClient(offer), link: linkFor(offer.code) });
  });

  app.get('/api/generatelinks/offers', requireGenKey, (req, res) => res.json(listOffers().map(toClient)));

  app.patch('/api/generatelinks/offers/:code', requireGenKey, (req, res) => {
    const o = getOffer(req.params.code);
    if (!o) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, offer: toClient(setOfferActive(o.code, o.active !== 1)) });
  });

  app.delete('/api/generatelinks/offers/:code', requireGenKey, (req, res) => { deleteOffer(req.params.code); res.json({ ok: true }); });

  app.get('/api/offer/:code', (req, res) => {
    const o = validateOffer(req.params.code);
    if (!o) return res.json({ valid: false });
    res.json({ valid: true, code: o.code, freeDays: o.freeDays, monthlyAmount: o.monthlyAmount });
  });
}
