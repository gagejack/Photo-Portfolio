import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagSvg } from '../../src/web/flags.js';

test('returns inline SVG for a known code', () => {
  const svg = flagSvg('jp');
  assert.match(svg, /^<svg/);
  assert.match(svg, /viewBox/);
});

test('is case insensitive', () => {
  assert.equal(flagSvg('JP'), flagSvg('jp'));
});

test('returns an empty string for unknown or missing codes', () => {
  assert.equal(flagSvg('zz'), '');
  assert.equal(flagSvg(null), '');
  assert.equal(flagSvg(undefined), '');
});
