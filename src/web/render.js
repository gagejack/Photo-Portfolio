const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ENTITIES[ch]);
}

// Generates a complete HTML5 document. Contract:
// - `title` is automatically escaped by this function.
// - `body` is NOT escaped — it must be pre-assembled trusted HTML. Callers are responsible for escaping user-supplied values (captions, category names) before interpolating them into body.
// - `styles` and `scripts` entries are developer-supplied literals (not user input) and interpolated unescaped into href/src attributes.
export function layoutPage({ title, body, styles = [], scripts = [] }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${styles.map(s => `<link rel="stylesheet" href="${s}">`).join('\n')}
</head>
<body>
${body}
${scripts.map(s => `<script src="${s}" defer></script>`).join('\n')}
</body>
</html>`;
}
