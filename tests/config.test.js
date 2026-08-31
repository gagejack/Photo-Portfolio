import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig reads values from env', () => {
  const cfg = loadConfig({
    PORT: '3000',
    DB_PATH: '/data/app.db',
    PHOTOS_ROOT: '/data/photos',
    SESSION_SECRET: 's'.repeat(32),
    ADMIN_USER: 'gage',
    ADMIN_PASSWORD_HASH: '$argon2id$fake',
  });
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.dbPath, '/data/app.db');
  assert.equal(cfg.adminUser, 'gage');
});

test('loadConfig throws when a required secret is missing', () => {
  assert.throws(
    () => loadConfig({ PORT: '3000' }),
    /SESSION_SECRET/
  );
});

test('loadConfig rejects a short session secret', () => {
  assert.throws(
    () => loadConfig({
      SESSION_SECRET: 'tooshort',
      PHOTOS_ROOT: '/p',
      DB_PATH: '/d',
      ADMIN_USER: 'g',
      ADMIN_PASSWORD_HASH: 'h',
    }),
    /at least 32/
  );
});
