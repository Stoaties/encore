import { Link, useNavigate } from 'react-router-dom';
import { Disc3, RefreshCw } from 'lucide-react';
import type { AlbumSummary, ArtistSummary } from '@encore/shared';
import { Cover } from './Cover';
import { useContextMenu, type ContextMenuItem } from '../state/contextMenu';
import { useRefetchableRequests, useRequestAction } from '../api/queries';

export function AlbumCard({ album }: { album: AlbumSummary }) {
  const navigate = useNavigate();
  const openMenu = useContextMenu((s) => s.openMenu);
  const { albums: refetchable } = useRefetchableRequests();
  const action = useRequestAction();
  const refetchReq = album.mbReleaseGroupId ? refetchable.get(album.mbReleaseGroupId) : undefined;

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const items: ContextMenuItem[] = [
      { label: 'Open album', icon: Disc3, onClick: () => navigate(`/library/albums/${album.id}`) },
    ];
    if (refetchReq) {
      items.push({
        label: 'Refetch',
        icon: RefreshCw,
        danger: true,
        onClick: () => {
          if (!window.confirm(`Wrong version? This will delete "${album.name}" and grab a different source from Soulseek.`)) return;
          action.mutate({ id: refetchReq.id, action: 'refetch' });
        },
      });
    }
    openMenu(e.clientX, e.clientY, items);
  };

  return (
    <Link
      to={`/library/albums/${album.id}`}
      onContextMenu={onContextMenu}
      className="group block rounded-lg bg-panel p-3 transition-colors hover:bg-panel-hover"
    >
      <Cover itemId={album.id} tag={album.imageTag} alt={album.name} className="mb-2 aspect-square w-full" />
      <div className="truncate text-sm font-medium">{album.name}</div>
      <div className="truncate text-xs text-zinc-400">
        {album.albumArtist}
        {album.year ? ` · ${album.year}` : ''}
      </div>
    </Link>
  );
}

export function ArtistCard({ artist }: { artist: ArtistSummary }) {
  return (
    <Link
      to={`/library/artists/${artist.id}`}
      className="group block rounded-lg bg-panel p-3 text-center transition-colors hover:bg-panel-hover"
    >
      <Cover
        itemId={artist.id}
        tag={artist.imageTag}
        alt={artist.name}
        className="mb-2 aspect-square w-full"
        rounded="rounded-full"
      />
      <div className="truncate text-sm font-medium">{artist.name}</div>
    </Link>
  );
}

export function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {children}
    </div>
  );
}
