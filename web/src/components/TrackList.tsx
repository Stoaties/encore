import { Pause, Play, X } from 'lucide-react';
import type { TrackSummary } from '@encore/shared';
import { playQueue, togglePlay } from '../state/audio';
import { currentTrack, usePlayer } from '../state/player';
import { fmtDuration } from '../lib/format';
import { Cover } from './Cover';
import { AddToPlaylistButton, HeartButton } from './TrackActions';

interface Props {
  tracks: TrackSummary[];
  showNumbers?: boolean;
  showCovers?: boolean;
  showAlbum?: boolean;
  /** renders an X per row (playlist editing) */
  onRemove?: (track: TrackSummary, index: number) => void;
}

export function TrackList({ tracks, showNumbers = false, showCovers = true, showAlbum = true, onRemove }: Props) {
  const playing = usePlayer((s) => s.isPlaying);
  const current = usePlayer((s) => currentTrack(s));

  return (
    <div className="flex flex-col">
      {tracks.map((t, i) => {
        const isCurrent = current?.id === t.id;
        return (
          <div
            key={`${t.id}-${i}`}
            className={`group flex w-full items-center gap-1 rounded-md pl-3 pr-2 hover:bg-panel-hover ${
              isCurrent ? 'text-accent' : ''
            }`}
          >
            <button
              onClick={() => (isCurrent ? togglePlay() : playQueue(tracks, i))}
              className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
            >
              {showNumbers && (
                <span className="w-6 shrink-0 text-right text-sm tabular-nums text-zinc-500">
                  <span className="group-hover:hidden">{isCurrent && playing ? '♪' : t.trackNumber ?? i + 1}</span>
                  <span className="hidden group-hover:inline">
                    {isCurrent && playing ? <Pause className="ml-auto size-4" /> : <Play className="ml-auto size-4" />}
                  </span>
                </span>
              )}
              {showCovers && (
                <Cover itemId={t.imageItemId} tag={t.imageTag} alt="" size={80} className="size-10 shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm font-medium ${isCurrent ? '' : 'text-zinc-100'}`}>
                  {t.name}
                </span>
                <span className="block truncate text-xs text-zinc-400">
                  {t.artists.join(', ')}
                  {showAlbum && t.album ? ` · ${t.album}` : ''}
                </span>
              </span>
            </button>
            <HeartButton itemId={t.id} />
            <AddToPlaylistButton itemIds={[t.id]} className="invisible group-hover:visible group-focus-within:visible" />
            {onRemove && (
              <button
                onClick={() => onRemove(t, i)}
                className="invisible rounded p-1.5 text-zinc-500 hover:text-white group-hover:visible group-focus-within:visible"
                aria-label={`Remove ${t.name}`}
              >
                <X className="size-4" />
              </button>
            )}
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-zinc-500">
              {fmtDuration(t.durationSec)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
