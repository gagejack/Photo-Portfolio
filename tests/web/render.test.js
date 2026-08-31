import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, layoutPage } from '../../src/web/render.js';

test('escapeHtml neutralizes markup', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
  );
});

test('escapeHtml handles ampersands and apostrophes', () => {
  assert.equal(escapeHtml(`Tom & Jerry's`), 'Tom &amp; Jerry&#39;s');
});

test('layoutPage emits a complete document with the title escaped', () => {
  const html = layoutPage({ title: 'A & B', body: '<p>hi</p>', styles: ['/css/site.css'], scripts: [] });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<title>A &amp; B<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/site\.css">/);
  assert.match(html, /<p>hi<\/p>/);
});
