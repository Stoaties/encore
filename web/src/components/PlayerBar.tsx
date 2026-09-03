import { ListMusic, Pause, Play, Repeat, Repeat1, SkipBack, SkipForward, Volume2, X } from 'lucide-react';
import { next, playTrackAt, prev, removeFromQueue, seek, setRepeat, setVolume, togglePlay } from '../state/audio';
import { currentTrack, usePlayer } from '../state/player';
import { fmtDuration } from '../lib/format';
import { Cover } from './Cover';
import { HeartButton } from './TrackActions';

export function PlayerBar() {
  const s = usePlayer();
  const track = currentTrack(s);
  if (!track) return null;

  const repeatNext = { off: 'all', all: 'one', one: 'off' } as const;

  return (
    <>
      {s.showQueue && <QueuePanel />}
      <div className="border-t border-zinc-800 bg-panel/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-3">
          <Cover itemId={track.imageItemId} tag={track.imageTag} alt="" size={120} className="size-12 shrink-0" />
          <div className="w-40 min-w-0 sm:w-56">
            <div className="truncate text-sm font-medium">{track.name}</div>
            <div className="truncate text-xs text-zinc-400">{track.artists.join(', ')}</div>
          </div>
          <HeartButton itemId={track.id} className="hidden shrink-0 sm:block" />

          <div className="flex flex-1 flex-col items-center gap-1">
            <div className="flex items-center gap-2">
              <button onClick={prev} className="rounded-full p-2 text-zinc-300 hover:text-white" aria-label="Previous">
                <SkipBack className="size-5" />
              </button>
              <button
                onClick={togglePlay}
                className="rounded-full bg-white p-2.5 text-black hover:scale-105"
                aria-label={s.isPlaying ? 'Pause' : 'Play'}
              >
                {s.isPlaying ? <Pause className="size-5" /> : <Play className="size-5 pl-0.5" />}
              </button>
              <button onClick={() => next()} className="rounded-full p-2 text-zinc-300 hover:text-white" aria-label="Next">
                <SkipForward className="size-5" />
              </button>
            </div>
            <div className="hidden w-full max-w-xl items-center gap-2 sm:flex">
              <span className="text-[10px] tabular-nums text-zinc-500">{fmtDuration(s.positionSec)}</span>
              <input
                type="range"
                min={0}
                max={Math.max(s.durationSec, 1)}
                step={0.5}
                value={Math.min(s.positionSec, s.durationSec)}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="Seek"
              />
              <span className="text-[10px] tabular-nums text-zinc-500">{fmtDuration(s.durationSec)}</span>
            </div>
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <button
              onClick={() => setRepeat(repeatNext[s.repeat])}
              className={`rounded p-2 ${s.repeat !== 'off' ? 'text-accent' : 'text-zinc-400 hover:text-white'}`}
              aria-label={`Repeat: ${s.repeat}`}
            >
              {s.repeat === 'one' ? <Repeat1 className="size-4" /> : <Repeat className="size-4" />}
            </button>
            <button
              onClick={() => s.setShowQueue(!s.showQueue)}
              className={`rounded p-2 ${s.showQueue ? 'text-accent' : 'text-zinc-400 hover:text-white'}`}
              aria-label="Queue"
            >
              <ListMusic className="size-4" />
            </button>
            <Volume2 className="size-4 text-zinc-400" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={s.volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="!w-20"
              aria-label="Volume"
            />
          </div>
        </div>
        {/* mobile seek bar */}
        <div className="mt-1 flex items-center gap-2 sm:hidden">
          <span className="text-[10px] tabular-nums text-zinc-500">{fmtDuration(s.positionSec)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(s.durationSec, 1)}
            step={0.5}
            value={Math.min(s.positionSec, s.durationSec)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek"
          />
          <span className="text-[10px] tabular-nums text-zinc-500">{fmtDuration(s.durationSec)}</span>
        </div>
      </div>
    </>
  );
}

function QueuePanel() {
  const s = usePlayer();
  return (
    <div className="absolute right-2 bottom-full mb-2 flex max-h-96 w-80 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-panel shadow-xl">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <span className="text-sm font-semibold">Queue · {s.queue.length}</span>
        <button onClick={() => s.setShowQueue(false)} aria-label="Close queue">
          <X className="size-4 text-zinc-400 hover:text-white" />
        </button>
      </div>
      <div className="overflow-y-auto">
        {s.queue.map((t, i) => (
          <div
            key={`${t.id}-${i}`}
            className={`group flex items-center gap-2 px-3 py-1.5 hover:bg-panel-hover ${
              i === s.index ? 'text-accent' : ''
            }`}
          >
            <button onClick={() => playTrackAt(i)} className="min-w-0 flex-1 text-left">
              <div className="truncate text-sm">{t.name}</div>
              <div className="truncate text-xs text-zinc-500">{t.artists.join(', ')}</div>
            </button>
            {i !== s.index && (
              <button
                onClick={() => removeFromQueue(i)}
                className="invisible group-hover:visible group-focus-within:visible"
                aria-label="Remove from queue"
              >
                <X className="size-4 text-zinc-500 hover:text-white" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
