import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getUserByUsername, getUserById, createUser, updateUserEmail, ensureSystemShelves } from './catalog.js';
import { redeemOfferForUser } from './billing.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRIAL_MS = 72 * 60 * 60 * 1000; // 72h free trial, then subscribe to keep reading/listening

router.post('/register', (req, res) => {
  const { username, password, email, offerCode } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (username.length < 2 || username.length > 30) return res.status(400).json({ error: 'Username must be 2–30 chars' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 chars' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (getUserByUsername(username)) return res.status(400).json({ error: 'Username taken' });

  const user = createUser({ id: uuidv4(), username, password, email: email || null, trialEndsAt: Date.now() + TRIAL_MS });
  ensureSystemShelves(user.id);
  let offer = null;
  if (offerCode) {
    const r = redeemOfferForUser(user.id, offerCode);
    if (r.ok) offer = { freeDays: r.freeDays, accessExpiresAt: r.accessExpiresAt, offerMonthlyAmount: r.offerMonthlyAmount };
  }
  req.session.user = { id: user.id, username: user.username, email: user.email };
  res.json({ ok: true, user: req.session.user, offer });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const user = getUserByUsername(username);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid username or password' });
  req.session.user = { id: user.id, username: user.username, email: user.email || null };
  res.json({ ok: true, user: req.session.user });
});

router.patch('/email', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not logged in' });
  const { email } = req.body;
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (!getUserById(req.session.user.id)) return res.status(404).json({ error: 'User not found' });
  const user = updateUserEmail(req.session.user.id, email || null);
  req.session.user = { ...req.session.user, email: user.email };
  res.json({ ok: true, email: user.email });
});

router.post('/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

export default router;
