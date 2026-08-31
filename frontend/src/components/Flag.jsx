const paths = {
  jp: <><rect width="30" height="20" fill="#fff" /><circle cx="15" cy="10" r="6" fill="#bc002d" /></>,
  fr: <><rect width="10" height="20" fill="#002395" /><rect x="10" width="10" height="20" fill="#fff" /><rect x="20" width="10" height="20" fill="#ed2939" /></>,
  it: <><rect width="10" height="20" fill="#009246" /><rect x="10" width="10" height="20" fill="#fff" /><rect x="20" width="10" height="20" fill="#ce2b37" /></>,
  de: <><rect width="30" height="6.67" fill="#000" /><rect y="6.67" width="30" height="6.67" fill="#d00" /><rect y="13.34" width="30" height="6.66" fill="#ffce00" /></>,
  ca: <><rect width="30" height="20" fill="#fff" /><rect width="7.5" height="20" fill="#d52b1e" /><rect x="22.5" width="7.5" height="20" fill="#d52b1e" /></>,
  mx: <><rect width="10" height="20" fill="#006847" /><rect x="10" width="10" height="20" fill="#fff" /><rect x="20" width="10" height="20" fill="#ce1126" /></>,
  us: <><rect width="30" height="20" fill="#fff" /><g fill="#b22234">{[0, 3.08, 6.16, 9.24, 12.32, 15.4, 18.48].map(y => <rect key={y} y={y} width="30" height="1.54" />)}</g><rect width="12" height="10.78" fill="#3c3b6e" /></>,
};

export default function Flag({ code }) {
  const content = paths[String(code ?? '').toLowerCase()];
  return content
    ? <svg className="flag" viewBox="0 0 30 20" aria-hidden="true">{content}</svg>
    : <span className="flagpad" />;
}
