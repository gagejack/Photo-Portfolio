import { api } from '../api.js';

export default function Nav({ active, authenticated }) {
  async function logout() {
    try {
      await api('/api/logout', { method: 'POST' });
    } finally {
      window.location.assign('/');
    }
  }

  return (
    <nav className="site-nav">
      <div className="nav-left">
        <a className="brand" href="/">Gage Jack</a>
        {authenticated && <a className={active === 'admin' ? 'admin-link cur' : 'admin-link'} href="/admin">admin</a>}
      </div>
      <div className="links">
        <a className={active === 'portfolio' ? 'cur' : ''} href="/">Portfolio</a>
        <a className={active === 'projects' ? 'cur' : ''} href="/other-projects">Other Projects</a>
        {authenticated && <button className="logout" type="button" onClick={logout}>Log out</button>}
      </div>
    </nav>
  );
}
