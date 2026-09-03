import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { SessionInfo } from '@encore/shared';
import { api } from './api/client';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { Search } from './pages/Search';
import { Artists, ArtistPage } from './pages/Artists';
import { Albums, AlbumPage } from './pages/Albums';
import { Requests } from './pages/Requests';
import { Playlists, PlaylistPage } from './pages/Playlists';
import { Favorites } from './pages/Favorites';
import { ImportPage } from './pages/Imports';
import { SharedPlaylist } from './pages/SharedPlaylist';
import { useSession } from './state/session';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const session = useSession((s) => s.session);
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  const session = useSession((s) => s.session);
  const setSession = useSession((s) => s.setSession);

  // revalidate the stored session once on boot (refreshes the Jellyfin token copy)
  useEffect(() => {
    if (!session) return;
    api<SessionInfo>('/api/auth/me')
      .then(setSession)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* /shared/:token is deliberately OUTSIDE RequireAuth so friends can
            open the link without an Encore/Jellyfin account. */}
        <Route path="/shared/:token" element={<SharedPlaylist />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Home />} />
          <Route path="/search" element={<Search />} />
          <Route path="/library/artists" element={<Artists />} />
          <Route path="/library/artists/:id" element={<ArtistPage />} />
          <Route path="/library/albums" element={<Albums />} />
          <Route path="/library/albums/:id" element={<AlbumPage />} />
          <Route path="/playlists" element={<Playlists />} />
          <Route path="/playlists/:id" element={<PlaylistPage />} />
          <Route path="/favorites" element={<Favorites />} />
          <Route path="/imports/:id" element={<ImportPage />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
