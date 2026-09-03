import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Play, RefreshCw, Shuffle } from 'lucide-react';
import { useAlbum, useAlbums, useRefetchableRequests, useRequestAction } from '../api/queries';
import { playQueue } from '../state/audio';
import { AlbumCard, CardGrid } from '../components/Cards';
import { Cover } from '../components/Cover';
import { SmartShuffleButton } from '../components/SmartShuffleButton';
import { TrackList } from '../components/TrackList';
import { fmtDuration } from '../lib/format';
import { PageSpinner } from './Home';

const sorts = [
  { key: 'name', label: 'A–Z' },
  { key: 'recent', label: 'Recent' },
  { key: 'year', label: 'Year' },
  { key: 'random', label: 'Random' },
] as const;

export function Albums() {
  const [sort, setSort] = useState<(typeof sorts)[number]['key']>('name');
  const { data, isLoading } = useAlbums(sort);
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-bold">Albums</h2>
        <div className="flex gap-1 rounded-full bg-panel p-1">
          {sorts.map((s) => (
            <button
              key={s.key}
              onClick={() => setSort(s.key)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                sort === s.key ? 'bg-panel-hover text-white' : 'text-zinc-400'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {isLoading ? <PageSpinner /> : <CardGrid>{data?.items.map((a) => <AlbumCard key={a.id} album={a} />)}</CardGrid>}
    </div>
  );
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function AlbumPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useAlbum(id);
  const { albums: refetchable } = useRefetchableRequests();
  const action = useRequestAction();
  if (isLoading || !data) return <PageSpinner />;
  const { album, tracks } = data;
  const refetchReq = album.mbReleaseGroupId ? refetchable.get(album.mbReleaseGroupId) : undefined;
  const onRefetch = () => {
    if (!refetchReq) return;
    if (!window.confirm(`Wrong version? This will delete "${album.name}" and grab a different source from Soulseek.`)) return;
    action.mutate({ id: refetchReq.id, action: 'refetch' });
  };
  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <Cover itemId={album.id} tag={album.imageTag} alt={album.name} size={500} className="size-40 shrink-0 sm:size-48" />
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Album</div>
          <h2 className="truncate text-3xl font-extrabold sm:text-4xl">{album.name}</h2>
          <div className="mt-1 text-sm text-zinc-400">
            {album.albumArtist}
            {album.year ? ` · ${album.year}` : ''} · {tracks.length} tracks ·{' '}
            {fmtDuration(tracks.reduce((s, t) => s + t.durationSec, 0))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => playQueue(tracks, 0)}
              className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black hover:bg-accent-dim"
            >
              <Play className="size-4" /> Play
            </button>
            <button
              onClick={() => playQueue(shuffled(tracks), 0)}
              className="flex items-center gap-2 rounded-full bg-panel-hover px-5 py-2 text-sm font-semibold hover:bg-zinc-700"
            >
              <Shuffle className="size-4" /> Shuffle
            </button>
            <SmartShuffleButton tracks={tracks} />
            {refetchReq && (
              <button
                onClick={onRefetch}
                disabled={action.isPending}
                className="flex items-center gap-2 rounded-full bg-panel-hover px-4 py-2 text-sm font-semibold text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
                title="Wrong version? Delete and grab a different source from Soulseek"
              >
                <RefreshCw className="size-4" /> Refetch
              </button>
            )}
          </div>
        </div>
      </div>
      <TrackList tracks={tracks} showNumbers showCovers={false} showAlbum={false} />
    </div>
  );
}
