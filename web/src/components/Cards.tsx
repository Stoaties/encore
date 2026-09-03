import { Link } from 'react-router-dom';
import type { AlbumSummary, ArtistSummary } from '@encore/shared';
import { Cover } from './Cover';

export function AlbumCard({ album }: { album: AlbumSummary }) {
  return (
    <Link
      to={`/library/albums/${album.id}`}
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
