import { useParams } from 'react-router-dom';
import { Play } from 'lucide-react';
import { useArtist, useArtists } from '../api/queries';
import { AlbumCard, ArtistCard, CardGrid } from '../components/Cards';
import { Cover } from '../components/Cover';
import { PageSpinner } from './Home';

export function Artists() {
  const { data, isLoading } = useArtists();
  if (isLoading) return <PageSpinner />;
  return (
    <div>
      <h2 className="mb-4 text-xl font-bold">Artists</h2>
      <CardGrid>{data?.items.map((a) => <ArtistCard key={a.id} artist={a} />)}</CardGrid>
    </div>
  );
}

export function ArtistPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useArtist(id);
  if (isLoading || !data) return <PageSpinner />;
  return (
    <div>
      <div className="mb-6 flex items-end gap-4">
        <Cover
          itemId={data.artist.id}
          tag={data.artist.imageTag}
          alt={data.artist.name}
          size={400}
          className="size-32 shrink-0 sm:size-40"
          rounded="rounded-full"
        />
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Artist</div>
          <h2 className="text-3xl font-extrabold sm:text-4xl">{data.artist.name}</h2>
          <div className="mt-1 text-sm text-zinc-400">{data.albums.length} albums</div>
        </div>
      </div>
      <CardGrid>
        {data.albums.map((a) => (
          <AlbumCard key={a.id} album={a} />
        ))}
      </CardGrid>
    </div>
  );
}

export { Play };
