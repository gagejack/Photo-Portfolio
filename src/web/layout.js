// src/web/layout.js

/**
 * Group photos into rows that each fill `containerWidth` exactly.
 *
 * Photos are accumulated until their combined aspect ratio would make a row
 * shorter than `targetHeight`, then the row is scaled so its widths plus
 * gutters sum to the container width. Aspect ratios are never altered, so
 * nothing is cropped.
 */
export function justify(photos, { containerWidth, targetHeight, gutter }) {
  const rows = [];
  let current = [];
  let ratioSum = 0;

  const flush = (isLast) => {
    if (current.length === 0) return;
    const available = containerWidth - gutter * (current.length - 1);
    let height = available / ratioSum;

    // A trailing row with few photos would stretch absurdly tall; cap it
    // and let it end short rather than dominate the page.
    if (isLast && height > targetHeight * 1.5) height = targetHeight;

    const roundedHeight = Math.round(height);
    const items = current.map((p, i) => ({
      photo: p,
      width: Math.round((p.width / p.height) * roundedHeight),
    }));

    // For interior rows, make the last item absorb rounding remainder to
    // ensure the row sums to exactly containerWidth. The final row is
    // intentionally allowed to end short.
    if (!isLast && items.length > 0) {
      const summedWidths = items.slice(0, -1).reduce((s, it) => s + it.width, 0);
      items[items.length - 1].width = available - summedWidths;
    }

    rows.push({
      height: roundedHeight,
      items,
    });
    current = [];
    ratioSum = 0;
  };

  for (const p of photos) {
    current.push(p);
    ratioSum += p.width / p.height;

    const available = containerWidth - gutter * (current.length - 1);
    if (available / ratioSum < targetHeight) flush(false);
  }
  flush(true);

  return rows;
}
