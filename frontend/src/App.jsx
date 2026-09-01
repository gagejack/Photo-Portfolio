import { useEffect, useState } from 'react';
import { api } from './api.js';
import Admin from './components/Admin.jsx';
import Login from './components/Login.jsx';
import Nav from './components/Nav.jsx';
import Portfolio from './components/Portfolio.jsx';

function Projects({ authenticated }) {
  return (
    <>
      <Nav active="projects" authenticated={authenticated} />
      <div className="stage">
        <p className="empty">
          <a href="https://speedmon.xyz" target="_blank" rel="noreferrer">speedmon.xyz</a>
        </p>
      </div>
    </>
  );
}

export default function App() {
  const path = window.location.pathname;
  const [authenticated, setAuthenticated] = useState(null);

  useEffect(() => {
    api('/api/session')
      .then(({ authenticated: value }) => setAuthenticated(value))
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (path === '/admin') document.title = 'Admin — Gage Jack Portfolio';
    else if (path === '/admin/login') document.title = 'Sign in — Gage Jack Portfolio';
    else if (path === '/other-projects') document.title = 'Other Projects — Gage Jack';
    else document.title = 'Gage Jack Portfolio';
  }, [path]);

  if (path === '/admin/login') {
    return <Login authenticated={authenticated} onLogin={() => setAuthenticated(true)} />;
  }
  if (path === '/admin') {
    return <Admin authenticated={authenticated} />;
  }
  if (path === '/other-projects') {
    return <Projects authenticated={Boolean(authenticated)} />;
  }

  const match = path.match(/^\/c\/([^/]+)\/?$/);
  const slug = match ? decodeURIComponent(match[1]) : null;
  if (path !== '/' && !match) {
    return <main className="message-page"><h1>Not found</h1></main>;
  }
  return <Portfolio slug={slug} authenticated={Boolean(authenticated)} />;
}
