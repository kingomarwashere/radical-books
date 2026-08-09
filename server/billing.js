// Stripe billing for Radical Books — hosted Checkout + webhook, mirroring Sound.
// Model: 72h free trial on sign-up, then A$5/mo or A$40/yr to keep reading/
// listening. Browsing is always free; only playback + reading are gated.
import Stripe from 'stripe';
import { getUserById, getUserByStripeCustomer, markUserPaid, revokeUserAccess,
  setUserOffer, getOffer, consumeOffer } from './catalog.js';

const SITE_URL = process.env.SITE_URL || 'https://books.theradicalparty.com';
const CURRENCY = process.env.STRIPE_CURRENCY || 'aud';

function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

export function getPaidInfo(userOrId) {
  const u = typeof userOrId === 'object' ? userOrId : getUserById(userOrId);
  if (!u) return { paid: false, inTrial: false, trialEndsAt: null, accessType: null, accessExpiresAt: null };
  const now = Date.now();
  const accessExpired = !!(u.access_expires_at && now > u.access_expires_at);
  const inTrial       = !!(u.trial_ends_at && now < u.trial_ends_at && u.paid !== 1);
  const paid          = (u.paid === 1 && !accessExpired) || inTrial;
  return {
    paid, inTrial,
    trialEndsAt:        u.trial_ends_at        || null,
    accessType:         u.access_type          || null,
    accessExpiresAt:    u.access_expires_at    || null,
    offerMonthlyAmount: u.offer_monthly_amount || null,
    offerCode:          u.offer_code           || null,
  };
}

export function validateOffer(code) {
  const o = getOffer(code);
  if (!o || o.active !== 1) return null;
  if (o.max_uses != null && o.uses >= o.max_uses) return null;
  return { code: o.code, freeDays: o.free_days || 0, monthlyAmount: o.monthly_amount, maxUses: o.max_uses, uses: o.uses };
}

export function redeemOfferForUser(userId, code) {
  const offer = validateOffer(code);
  if (!offer) return { ok: false, error: 'Invalid or expired code' };
  consumeOffer(offer.code);
  let accessExpiresAt = null;
  if (offer.freeDays > 0) {
    accessExpiresAt = Date.now() + offer.freeDays * 86400000;
    markUserPaid(userId, { accessType: 'offer', expiresAt: accessExpiresAt });
  }
  setUserOffer(userId, { monthlyAmount: offer.monthlyAmount, code: offer.code });
  return { ok: true, accessExpiresAt, offerMonthlyAmount: offer.monthlyAmount, freeDays: offer.freeDays };
}

export function isPaid(userOrId) { return getPaidInfo(userOrId).paid; }

function syncFromSubscription(sub) {
  const u = getUserByStripeCustomer(sub.customer);
  if (!u) { console.warn(`[billing] no user for customer ${sub.customer}`); return; }
  const active = sub.status === 'active' || sub.status === 'trialing';
  if (active) {
    const expiresAt = sub.current_period_end ? sub.current_period_end * 1000 : null;
    markUserPaid(u.id, { accessType: 'stripe', customerId: sub.customer, subscriptionId: sub.id, expiresAt });
    console.log(`[billing] ${u.username} → active (${sub.status})`);
  } else if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) {
    revokeUserAccess(u.id);
    console.log(`[billing] ${u.username} → revoked (${sub.status})`);
  }
}

export async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).send('STRIPE_WEBHOOK_SECRET not set');
  let event;
  try { event = stripe().webhooks.constructEvent(req.body, sig, secret); }
  catch (e) { console.error('[webhook] verify failed:', e.message); return res.status(400).send(`Webhook error: ${e.message}`); }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const userId = s.client_reference_id || s.metadata?.userId;
        if (userId && s.subscription) {
          markUserPaid(userId, { accessType: 'stripe', customerId: s.customer, subscriptionId: s.subscription });
          try { syncFromSubscription(await stripe().subscriptions.retrieve(s.subscription)); }
          catch (e) { console.warn('[webhook] sub retrieve failed:', e.message); }
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
      case 'customer.subscription.deleted':
        syncFromSubscription(event.data.object); break;
      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        if (inv.subscription) {
          try { syncFromSubscription(await stripe().subscriptions.retrieve(inv.subscription)); }
          catch (e) { console.warn('[webhook] renewal sync failed:', e.message); }
        }
        break;
      }
      default: break;
    }
  } catch (e) { console.error('[webhook] handler error:', e.message); }
  res.json({ received: true });
}

export function billingRoutes(app, { requireAuth }) {
  const PRICES = { monthly: process.env.STRIPE_PRICE_MONTHLY, annual: process.env.STRIPE_PRICE_ANNUAL };

  app.post('/api/billing/checkout', requireAuth, async (req, res) => {
    const plan = ['annual', 'offer'].includes(req.body?.plan) ? req.body.plan : 'monthly';
    const user = getUserById(req.session.user.id);
    if (!user) return res.status(401).json({ error: 'Not logged in' });

    const subMeta = { userId: user.id, username: user.username };
    let lineItems, subscriptionData = { metadata: subMeta };

    if (plan === 'offer') {
      const amount = user.offer_monthly_amount;
      if (!amount) return res.status(400).json({ error: 'No offer on this account' });
      lineItems = [{ price_data: { currency: CURRENCY, unit_amount: amount, recurring: { interval: 'month' }, product_data: { name: 'Radical Books Membership' } }, quantity: 1 }];
      if (user.access_expires_at && user.access_expires_at > Date.now()) {
        const days = Math.ceil((user.access_expires_at - Date.now()) / 86400000);
        if (days >= 1) subscriptionData.trial_period_days = days;
      }
    } else {
      const priceId = PRICES[plan];
      if (!priceId) return res.status(500).json({ error: `price for ${plan} not configured` });
      lineItems = [{ price: priceId, quantity: 1 }];
    }

    try {
      const session = await stripe().checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: lineItems,
        client_reference_id: user.id,
        ...(user.stripe_customer_id ? { customer: user.stripe_customer_id } : { customer_email: user.email || undefined }),
        metadata: { userId: user.id, username: user.username, plan, offerCode: user.offer_code || '' },
        subscription_data: subscriptionData,
        allow_promotion_codes: plan !== 'offer',
        success_url: `${SITE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${SITE_URL}/upgrade`,
      });
      res.json({ url: session.url });
    } catch (e) { console.error('[billing] checkout error:', e.message); res.status(500).json({ error: 'Could not start checkout' }); }
  });

  app.post('/api/billing/redeem', requireAuth, (req, res) => {
    const code = (req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Code required' });
    const result = redeemOfferForUser(req.session.user.id, code);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  });

  app.get('/billing/success', requireAuth, async (req, res) => {
    const sid = req.query.session_id;
    if (sid) {
      try {
        const s = await stripe().checkout.sessions.retrieve(sid);
        if (s.client_reference_id === req.session.user.id && s.subscription) {
          markUserPaid(req.session.user.id, { accessType: 'stripe', customerId: s.customer, subscriptionId: s.subscription });
          try { syncFromSubscription(await stripe().subscriptions.retrieve(s.subscription)); } catch {}
        }
      } catch (e) { console.warn('[billing] success fallback failed:', e.message); }
    }
    res.redirect('/?subscribed=1');
  });

  app.post('/api/billing/portal', requireAuth, async (req, res) => {
    const user = getUserById(req.session.user.id);
    if (!user?.stripe_customer_id) return res.status(400).json({ error: 'No subscription to manage' });
    try {
      const portal = await stripe().billingPortal.sessions.create({ customer: user.stripe_customer_id, return_url: `${SITE_URL}/` });
      res.json({ url: portal.url });
    } catch (e) { console.error('[billing] portal error:', e.message); res.status(500).json({ error: 'Could not open billing portal' }); }
  });
}
