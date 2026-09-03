import { NavLink, Outlet } from 'react-router-dom';
import { Disc3, Home, ListMusic, LogOut, Mic2, Search, Download } from 'lucide-react';
import { useSession } from '../state/session';
import { useServerEvents } from '../api/sse';
import { PlayerBar } from './PlayerBar';
import { ContextMenu } from './ContextMenu';

const navItems = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/search', label: 'Search', icon: Search, end: false },
  { to: '/library/artists', label: 'Artists', icon: Mic2, end: false },
  { to: '/library/albums', label: 'Albums', icon: Disc3, end: false },
  { to: '/playlists', label: 'Playlists', icon: ListMusic, end: false },
  { to: '/requests', label: 'Requests', icon: Download, end: false },
];

export function Layout() {
  const session = useSession((s) => s.session);
  const logout = useSession((s) => s.logout);
  useServerEvents();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      isActive ? 'bg-panel-hover text-white' : 'text-zinc-400 hover:text-white'
    }`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* desktop sidebar */}
        <aside className="hidden w-56 shrink-0 flex-col gap-1 border-r border-zinc-800 bg-panel/50 p-3 md:flex">
          <div className="mb-4 flex items-center gap-2 px-2 pt-1">
            <Disc3 className="size-6 text-accent" />
            <span className="text-lg font-bold tracking-tight">Encore</span>
          </div>
          {navItems.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={linkClass}>
              <n.icon className="size-4" /> {n.label}
            </NavLink>
          ))}
          <div className="mt-auto border-t border-zinc-800 pt-3">
            <div className="flex items-center justify-between px-2">
              <span className="truncate text-sm text-zinc-400">{session?.user.username}</span>
              <button onClick={logout} className="p-1 text-zinc-500 hover:text-white" aria-label="Log out">
                <LogOut className="size-4" />
              </button>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto p-4 pb-6 md:p-6">
          <Outlet />
        </main>
      </div>

      <div className="relative shrink-0">
        <PlayerBar />
      </div>

      <ContextMenu />

      {/* mobile bottom tabs */}
      <nav className="flex shrink-0 border-t border-zinc-800 bg-panel md:hidden">
        {navItems.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] ${
                isActive ? 'text-accent' : 'text-zinc-400'
              }`
            }
          >
            <n.icon className="size-5" />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
