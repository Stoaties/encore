import { Pause, Play, RefreshCw, X } from 'lucide-react';
import type { TrackSummary } from '@encore/shared';
import { playQueue, togglePlay } from '../state/audio';
import { currentTrack, usePlayer } from '../state/player';
import { fmtDuration } from '../lib/format';
import { Cover } from './Cover';
import { AddToPlaylistButton, HeartButton } from './TrackActions';
import { useRefetchableRequests, useRequestAction } from '../api/queries';
import { useContextMenu, type ContextMenuItem } from '../state/contextMenu';

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
  const { tracks: refetchable } = useRefetchableRequests();
  const action = useRequestAction();
  const openMenu = useContextMenu((s) => s.openMenu);

  const onRefetch = (t: TrackSummary, requestId: string) => {
    if (!window.confirm(`Wrong version? This will delete "${t.name}" and grab a different source from Soulseek.`)) return;
    action.mutate({ id: requestId, action: 'refetch' });
  };

  const openTrackMenu = (e: React.MouseEvent, t: TrackSummary, i: number, requestId: string | undefined) => {
    e.preventDefault();
    const items: ContextMenuItem[] = [
      { label: 'Play', icon: Play, onClick: () => playQueue(tracks, i) },
    ];
    if (onRemove) {
      items.push({ label: 'Remove from playlist', icon: X, onClick: () => onRemove(t, i), danger: true });
    }
    if (requestId) {
      items.push({ label: 'Refetch', icon: RefreshCw, onClick: () => onRefetch(t, requestId), danger: true });
    }
    openMenu(e.clientX, e.clientY, items);
  };

  return (
    <div className="flex flex-col">
      {tracks.map((t, i) => {
        const isCurrent = current?.id === t.id;
        const refetchReq = t.mbRecordingId ? refetchable.get(t.mbRecordingId) : undefined;
        return (
          <div
            key={`${t.id}-${i}`}
            onContextMenu={(e) => openTrackMenu(e, t, i, refetchReq?.id)}
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
            {refetchReq && (
              <button
                onClick={() => onRefetch(t, refetchReq.id)}
                disabled={action.isPending}
                className="invisible rounded p-1.5 text-zinc-500 hover:text-white group-hover:visible group-focus-within:visible disabled:opacity-40"
                aria-label={`Refetch ${t.name}`}
                title="Wrong version? Delete and grab a different source"
              >
                <RefreshCw className="size-4" />
              </button>
            )}
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
