const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function justify(photos, { containerWidth, targetHeight, gutter }) {
  const rows = [];
  let current = [];
  let ratioSum = 0;

  const flush = isLast => {
    if (!current.length) return;
    const available = containerWidth - gutter * (current.length - 1);
    let height = available / ratioSum;
    if (isLast && height > targetHeight * 1.5) height = targetHeight;

    const roundedHeight = Math.round(height);
    const items = current.map(photo => ({
      photo,
      width: Math.round((photo.width / photo.height) * roundedHeight),
    }));
    if (!isLast && items.length) {
      const used = items.slice(0, -1).reduce((sum, item) => sum + item.width, 0);
      items.at(-1).width = available - used;
    }
    rows.push({ height: roundedHeight, items });
    current = [];
    ratioSum = 0;
  };

  for (const photo of photos) {
    current.push(photo);
    ratioSum += photo.width / photo.height;
    const available = containerWidth - gutter * (current.length - 1);
    if (available / ratioSum < targetHeight) flush(false);
  }
  flush(true);
  return rows;
}

export function buildRail(photos) {
  const years = new Map();
  for (const photo of photos) {
    const date = new Date(photo.takenAt);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    if (!years.has(year)) years.set(year, new Map());
    if (!years.get(year).has(month)) {
      years.get(year).set(month, {
        label: MONTHS[month],
        key: `${year}-${month}`,
        firstPhotoId: photo.id,
      });
    }
  }
  return [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => ({
      year,
      months: [...months.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, value]) => value),
    }));
}

export function photoBase(filename) {
  return filename.replace(/\.[^.]+$/, '');
}
