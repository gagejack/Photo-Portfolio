
// Flat rectangle flags as inline SVG. No network fetch, no emoji font
// dependency, identical rendering everywhere. Add a country here when a
// new one is needed.
const FLAGS = {
  jp: '<rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="6" fill="#bc002d"/>',
  us: '<rect width="30" height="20" fill="#fff"/>' +
      '<g fill="#b22234">' +
      [0, 3.08, 6.16, 9.24, 12.32, 15.4, 18.48]
        .map(y => `<rect y="${y}" width="30" height="1.54"/>`).join('') +
      '</g><rect width="12" height="10.78" fill="#3c3b6e"/>',
  fr: '<rect width="10" height="20" fill="#002395"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#ed2939"/>',
  it: '<rect width="10" height="20" fill="#009246"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#ce2b37"/>',
  de: '<rect width="30" height="6.67" fill="#000"/><rect y="6.67" width="30" height="6.67" fill="#dd0000"/><rect y="13.34" width="30" height="6.66" fill="#ffce00"/>',
  ca: '<rect width="30" height="20" fill="#fff"/><rect width="7.5" height="20" fill="#d52b1e"/><rect x="22.5" width="7.5" height="20" fill="#d52b1e"/>',
  mx: '<rect width="10" height="20" fill="#006847"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#ce1126"/>',
};

export function flagSvg(code) {
  if (!code) return '';
  const inner = FLAGS[String(code).toLowerCase()];
  if (!inner) return '';
  return `<svg class="flag" viewBox="0 0 30 20" aria-hidden="true">${inner}</svg>`;
}
