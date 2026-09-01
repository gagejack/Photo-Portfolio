import sharp from 'sharp';

function channelHex(value) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

// Sharp's dominant color is histogram-based, which is a better fit for this
// feature than a plain average that can turn a colorful photo muddy gray.
export async function dominantColor(input) {
  const { dominant } = await sharp(input).stats();
  return `#${channelHex(dominant.r)}${channelHex(dominant.g)}${channelHex(dominant.b)}`;
}

function colorKey(hex) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!match) return [2, 0, 0, 0];

  const [r, g, b] = match.slice(1).map(value => parseInt(value, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }

  // Keep chromatic colors in a red-to-violet spectrum. Near-neutral images
  // follow afterward from dark to light, and unknown colors come last.
  return saturation < 0.12
    ? [1, lightness, 0, 0]
    : [0, hue, 1 - saturation, lightness];
}

export function compareDominantColors(first, second) {
  const a = colorKey(first);
  const b = colorKey(second);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
