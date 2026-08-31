import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Login({ authenticated, onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (authenticated) window.location.replace('/admin');
  }, [authenticated]);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api('/api/login', { method: 'POST', body: { username, password } });
      onLogin();
      window.location.assign('/admin');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login">
      <a className="login-brand" href="/">Gage Jack</a>
      {error && <p className="error" role="alert">{error}</p>}
      <form onSubmit={submit}>
        <label>
          <span className="sr-only">Username</span>
          <input value={username} onChange={event => setUsername(event.target.value)} placeholder="Username" autoComplete="username" required />
        </label>
        <label>
          <span className="sr-only">Password</span>
          <input value={password} onChange={event => setPassword(event.target.value)} type="password" placeholder="Password" autoComplete="current-password" required />
        </label>
        <button type="submit" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
