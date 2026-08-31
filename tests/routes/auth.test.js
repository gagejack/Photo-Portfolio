import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import argon2 from 'argon2';
import { authRouter, requireApiAuth } from '../../src/routes/auth.js';

async function makeApp() {
  const config = {
    adminUser: 'gage',
    adminHash: await argon2.hash('correct-horse', { type: argon2.argon2id }),
    sessionSecret: 's'.repeat(32),
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(session({ secret: config.sessionSecret, resave: false, saveUninitialized: false }));
  app.use(authRouter(config));
  app.get('/api/secret', requireApiAuth, (req, res) => res.json({ value: 'classified' }));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('unauthenticated API access returns JSON 401', async () => {
  const { server, base } = await listen(await makeApp());
  const response = await fetch(`${base}/api/secret`);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Authentication required' });
  server.close();
});

test('correct credentials create a session usable by protected APIs', async () => {
  const { server, base } = await listen(await makeApp());
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'gage', password: 'correct-horse' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie, 'a session cookie should be set');

  const response = await fetch(`${base}/api/secret`, { headers: { cookie } });
  assert.deepEqual(await response.json(), { value: 'classified' });
  server.close();
});

test('session status and logout reflect authentication state', async () => {
  const { server, base } = await listen(await makeApp());
  assert.deepEqual(await (await fetch(`${base}/api/session`)).json(), { authenticated: false });
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'gage', password: 'correct-horse' }),
  });
  const cookie = login.headers.get('set-cookie');
  assert.deepEqual(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json(), { authenticated: true });
  assert.equal((await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } })).status, 204);
  server.close();
});

test('wrong credentials are rejected with the same generic JSON message', async () => {
  const { server, base } = await listen(await makeApp());
  for (const credentials of [
    { username: 'gage', password: 'wrong' },
    { username: 'nobody', password: 'correct-horse' },
  ]) {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Invalid username or password.' });
  }
  server.close();
});
