// tests/web/layout.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { justify } from '../../src/web/layout.js';

const photo = (id, width, height) => ({ id, width, height });

test('every row fills the container width exactly', () => {
  const photos = Array.from({ length: 12 }, (_, i) =>
    photo(i, i % 2 ? 4000 : 3000, i % 3 ? 3000 : 4000)
  );
  const rows = justify(photos, { containerWidth: 1600, targetHeight: 320, gutter: 10 });

  for (const row of rows.slice(0, -1)) {
    const total =
      row.items.reduce((s, it) => s + it.width, 0) + (row.items.length - 1) * 10;
    assert.ok(Math.abs(total - 1600) < 1, `row width ${total} should be 1600`);
  }
});

test('aspect ratios are preserved within a row', () => {
  const photos = [photo(1, 4000, 2000), photo(2, 2000, 2000), photo(3, 3000, 2000)];
  const rows = justify(photos, { containerWidth: 1200, targetHeight: 300, gutter: 10 });
  for (const row of rows) {
    for (const item of row.items) {
      const original = item.photo.width / item.photo.height;
      assert.ok(Math.abs(item.width / row.height - original) < 0.01);
    }
  }
});

test('every photo appears exactly once, in order', () => {
  const photos = Array.from({ length: 17 }, (_, i) => photo(i, 3000 + i * 50, 2000));
  const rows = justify(photos, { containerWidth: 1600, targetHeight: 320, gutter: 10 });
  const ids = rows.flatMap(r => r.items.map(it => it.photo.id));
  assert.deepEqual(ids, photos.map(p => p.id));
});

test('the final row is not stretched beyond a sane height', () => {
  const photos = [photo(1, 4000, 2250)];
  const rows = justify(photos, { containerWidth: 1600, targetHeight: 320, gutter: 10 });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].height <= 320 * 1.5);
});

test('a narrow container puts one photo per row', () => {
  const photos = [photo(1, 4000, 3000), photo(2, 3000, 4000)];
  const rows = justify(photos, { containerWidth: 380, targetHeight: 320, gutter: 10 });
  assert.equal(rows.length, 2);
});

test('an empty input produces no rows', () => {
  assert.deepEqual(justify([], { containerWidth: 1600, targetHeight: 320, gutter: 10 }), []);
});
