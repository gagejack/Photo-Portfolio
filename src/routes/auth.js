import express from 'express';
import argon2 from 'argon2';

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';

function tooManyAttempts(ip) {
  const record = attempts.get(ip);
  if (!record) return false;
  if (Date.now() - record.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const record = attempts.get(ip);
  if (!record || Date.now() - record.first > WINDOW_MS) {
    attempts.set(ip, { first: Date.now(), count: 1 });
  } else {
    record.count += 1;
  }
}

async function verifyCredentials(config, username, password) {
  const hash = username === config.adminUser ? config.adminHash : DUMMY_HASH;
  try {
    return username === config.adminUser && await argon2.verify(hash, String(password ?? ''));
  } catch {
    return false;
  }
}

function startSession(req, username) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) return reject(error);
      req.session.user = username;
      resolve();
    });
  });
}

export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect('/admin/login');
}

export function requireApiAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

export function authRouter(config) {
  const router = express.Router();

  router.get('/api/session', (req, res) => {
    res.json({ authenticated: Boolean(req.session?.user) });
  });

  router.post('/api/login', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (tooManyAttempts(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    const { username, password } = req.body ?? {};
    if (!await verifyCredentials(config, username, password)) {
      recordAttempt(ip);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    attempts.delete(ip);
    try {
      await startSession(req, username);
      return res.json({ authenticated: true });
    } catch {
      return res.status(500).json({ error: 'Session error. Try again.' });
    }
  });

  router.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.status(204).end());
  });

  // Form-compatible endpoints keep old bookmarks and scripted logins working.
  // The React client exclusively uses the JSON endpoints above.
  router.post('/admin/login', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    const { username, password } = req.body ?? {};
    if (tooManyAttempts(ip)) return res.status(429).send('Too many attempts. Try again later.');
    if (!await verifyCredentials(config, username, password)) {
      recordAttempt(ip);
      return res.status(401).send('Invalid username or password.');
    }
    attempts.delete(ip);
    try {
      await startSession(req, username);
      return res.redirect('/admin');
    } catch {
      return res.status(500).send('Session error. Try again.');
    }
  });

  router.post('/admin/logout', (req, res) => {
    const returnTo = req.body?.returnTo === '/' ? '/' : '/admin/login';
    req.session.destroy(() => res.redirect(returnTo));
  });

  return router;
}
