import { Heart, Play } from 'lucide-react';
import { useFavorites } from '../api/queries';
import { playQueue } from '../state/audio';
import { SmartShuffleButton } from '../components/SmartShuffleButton';
import { TrackList } from '../components/TrackList';
import { fmtDuration } from '../lib/format';
import { PageSpinner } from './Home';

export function Favorites() {
  const { data: tracks, isLoading } = useFavorites();
  if (isLoading || !tracks) return <PageSpinner />;

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex size-40 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-accent/80 to-purple-800 sm:size-48">
          <Heart className="size-1/3 fill-white text-white" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Playlist</div>
          <h2 className="truncate text-3xl font-extrabold sm:text-4xl">Liked Songs</h2>
          <div className="mt-1 text-sm text-zinc-400">
            {tracks.length} tracks · {fmtDuration(tracks.reduce((s, t) => s + t.durationSec, 0))}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => playQueue(tracks, 0)}
              disabled={!tracks.length}
              className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black hover:bg-accent-dim disabled:opacity-50"
            >
              <Play className="size-4" /> Play
            </button>
            <SmartShuffleButton tracks={tracks} />
          </div>
        </div>
      </div>
      {tracks.length ? (
        <TrackList tracks={tracks} />
      ) : (
        <p className="text-sm text-zinc-400">Nothing here yet — tap the heart on any track.</p>
      )}
    </div>
  );
}
