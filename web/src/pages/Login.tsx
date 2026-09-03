import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Disc3 } from 'lucide-react';
import type { SessionInfo } from '@encore/shared';
import { api, ApiError } from '../api/client';
import { isNativeApp, useSession } from '../state/session';

export function Login() {
  const navigate = useNavigate();
  const { setSession, serverUrl, setServerUrl } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(serverUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const showServer = isNativeApp() || !!serverUrl;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (showServer) setServerUrl(server);
      const session = await api<SessionInfo>('/api/auth/login', {
        method: 'POST',
        body: { username, password },
        auth: false,
      });
      setSession(session);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-zinc-800 bg-panel p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Disc3 className="size-8 text-accent" />
          <span className="text-2xl font-bold tracking-tight">Encore</span>
        </div>
        <p className="mb-4 text-center text-sm text-zinc-400">Sign in with your Jellyfin account</p>
        {showServer && (
          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-medium text-zinc-400">Server URL</span>
            <input
              type="url"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="https://music.example.com"
              className="w-full rounded-md border border-zinc-700 bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
        )}
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-zinc-400">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            className="w-full rounded-md border border-zinc-700 bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-medium text-zinc-400">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-full rounded-md border border-zinc-700 bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !username}
          className="w-full rounded-md bg-accent py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-dim disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
