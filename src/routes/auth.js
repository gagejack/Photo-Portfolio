import express from 'express';
import argon2 from 'argon2';
import { layoutPage, escapeHtml } from '../web/render.js';

// In-memory attempt tracking. Single process, single account — a shared
// store would add a dependency for no gain.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(ip, { first: Date.now(), count: 1 });
  } else {
    rec.count += 1;
  }
}

function loginPage(error) {
  return layoutPage({
    title: 'Sign in',
    styles: ['/css/admin.css'],
    body: `
<div class="login">
  <h1>Gage Jack</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/admin/login">
    <input name="username" placeholder="Username" autocomplete="username" required>
    <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</div>`,
  });
}

export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect('/admin/login');
}

export function authRouter(config) {
  const router = express.Router();

  router.get('/admin/login', (req, res) => {
    if (req.session?.user) return res.redirect('/admin');
    res.send(loginPage(null));
  });

  router.post('/admin/login', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (tooManyAttempts(ip)) {
      return res.status(429).send(loginPage('Too many attempts. Try again later.'));
    }

    const { username, password } = req.body ?? {};

    // Always run a verification so timing does not reveal whether the
    // username existed.
    const hashToCheck = username === config.adminUser
      ? config.adminHash
      : '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';

    let ok = false;
    try {
      ok = await argon2.verify(hashToCheck, String(password ?? ''));
    } catch {
      ok = false;
    }

    if (!ok || username !== config.adminUser) {
      recordAttempt(ip);
      return res.status(401).send(loginPage('Invalid username or password.'));
    }

    attempts.delete(ip);
    req.session.regenerate(err => {
      if (err) return res.status(500).send(loginPage('Session error. Try again.'));
      req.session.user = config.adminUser;
      res.redirect('/admin');
    });
  });

  router.post('/admin/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
  });

  return router;
}
