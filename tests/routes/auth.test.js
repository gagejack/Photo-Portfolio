import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import argon2 from 'argon2';
import { authRouter, requireAuth } from '../../src/routes/auth.js';

async function makeApp() {
  const config = {
    adminUser: 'gage',
    adminHash: await argon2.hash('correct-horse', { type: argon2.argon2id }),
    sessionSecret: 's'.repeat(32),
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: config.sessionSecret, resave: false, saveUninitialized: false }));
  app.use(authRouter(config));
  app.get('/admin/secret', requireAuth, (req, res) => res.send('classified'));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('unauthenticated access to an admin route redirects to login', async () => {
  const { server, base } = await listen(await makeApp());
  const res = await fetch(`${base}/admin/secret`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/login');
  server.close();
});

test('correct credentials grant access', async () => {
  const { server, base } = await listen(await makeApp());
  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=gage&password=correct-horse',
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie, 'a session cookie should be set');

  const res = await fetch(`${base}/admin/secret`, { headers: { cookie } });
  assert.equal(await res.text(), 'classified');
  server.close();
});

test('a wrong password is rejected with a generic message', async () => {
  const { server, base } = await listen(await makeApp());
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=gage&password=wrong',
    redirect: 'manual',
  });
  const body = await res.text();
  assert.match(body, /invalid/i);
  assert.doesNotMatch(body, /password is incorrect|no such user/i);
  server.close();
});

test('a wrong username is rejected the same way', async () => {
  const { server, base } = await listen(await makeApp());
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=nobody&password=correct-horse',
    redirect: 'manual',
  });
  assert.match(await res.text(), /invalid/i);
  server.close();
});
