// Public view of a shared playlist. No login required — the share token in the
// URL is the only credential. Encore's server proxies both metadata and audio
// so this page never sees a real Jellyfin URL/credential.
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Disc3, ListMusic, Loader2, Pause, Play } from 'lucide-react';
import type { SharedPlaylistView, SharedTrack } from '@encore/shared';
import { fmtDuration } from '../lib/format';

async function fetchShare(token: string): Promise<SharedPlaylistView> {
  const res = await fetch(`/api/public/playlists/${encodeURIComponent(token)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Could not load share (${res.status})`);
  }
  return res.json();
}

export function SharedPlaylist() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<SharedPlaylistView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<number>(-1);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!token) return;
    fetchShare(token).then(setData).catch((err: Error) => setError(err.message));
  }, [token]);

  useEffect(() => {
    // fresh audio element on each track so seek/pause state don't survive
    // across track changes in unexpected ways
    if (current < 0 || !data) return;
    const track = data.tracks[current];
    if (!track) return;
    audioRef.current?.pause();
    const el = new Audio(track.audioUrl);
    audioRef.current = el;
    el.addEventListener('play', () => setPlaying(true));
    el.addEventListener('pause', () => setPlaying(false));
    el.addEventListener('ended', () => {
      if (current + 1 < data.tracks.length) setCurrent(current + 1);
      else setPlaying(false);
    });
    // fire-and-forget: some browsers reject autoplay without a gesture — but
    // the click that led here IS a gesture, so this usually succeeds
    void el.play().catch(() => setPlaying(false));
    return () => {
      el.pause();
    };
  }, [current, data]);

  const playAt = (idx: number) => setCurrent(idx);
  const toggle = () => {
    if (!audioRef.current) return;
    if (audioRef.current.paused) void audioRef.current.play().catch(() => {});
    else audioRef.current.pause();
  };

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center p-4">
        <div className="max-w-sm rounded-xl border border-zinc-800 bg-panel p-6 text-center">
          <Disc3 className="mx-auto mb-3 size-8 text-accent" />
          <p className="text-lg font-semibold">Share unavailable</p>
          <p className="mt-2 text-sm text-zinc-400">{error}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="size-8 animate-spin text-zinc-500" />
      </div>
    );
  }

  const currentTrack = current >= 0 ? data.tracks[current] : null;
  const totalDurationSec = data.tracks.reduce((s, t) => s + t.durationSec, 0);

  return (
    <div className="min-h-screen bg-surface text-zinc-100">
      <header className="border-b border-zinc-800 px-4 py-3">
        <div className="mx-auto flex max-w-4xl items-center gap-2">
          <Disc3 className="size-6 text-accent" />
          <span className="text-lg font-bold">Encore</span>
          <span className="ml-auto text-xs text-zinc-500">Shared by {data.ownerName}</span>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6 pb-32">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex size-40 shrink-0 items-center justify-center overflow-hidden rounded-md bg-panel-hover text-zinc-500 sm:size-48">
            {data.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={data.imageUrl} alt="" className="size-full object-cover" />
            ) : (
              <ListMusic className="size-1/3" />
            )}
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Shared playlist</div>
            <h2 className="truncate text-3xl font-extrabold sm:text-4xl">{data.name}</h2>
            <div className="mt-1 text-sm text-zinc-400">
              {data.tracks.length} tracks · {fmtDuration(totalDurationSec)}
            </div>
            <div className="mt-3">
              <button
                onClick={() => (current >= 0 ? toggle() : playAt(0))}
                disabled={!data.tracks.length}
                className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black hover:bg-accent-dim disabled:opacity-50"
              >
                {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                {playing ? 'Pause' : 'Play'}
              </button>
            </div>
          </div>
        </div>
        <ol className="flex flex-col">
          {data.tracks.map((t, i) => (
            <SharedRow key={t.id} track={t} index={i} isCurrent={i === current} onPlay={() => playAt(i)} />
          ))}
        </ol>
      </main>
      {currentTrack && (
        <div className="fixed inset-x-0 bottom-0 border-t border-zinc-800 bg-panel px-4 py-2">
          <div className="mx-auto flex max-w-4xl items-center gap-3">
            <button onClick={toggle} className="rounded-full bg-accent p-2 text-black hover:bg-accent-dim">
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{currentTrack.name}</div>
              <div className="truncate text-xs text-zinc-400">{currentTrack.artists.join(', ')}</div>
            </div>
            <div className="text-xs text-zinc-500">{fmtDuration(currentTrack.durationSec)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function SharedRow({
  track,
  index,
  isCurrent,
  onPlay,
}: {
  track: SharedTrack;
  index: number;
  isCurrent: boolean;
  onPlay: () => void;
}) {
  return (
    <li>
      <button
        onClick={onPlay}
        className={`group grid w-full grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-panel-hover ${
          isCurrent ? 'text-accent' : ''
        }`}
      >
        <span className="text-right text-sm tabular-nums text-zinc-500 group-hover:hidden">{index + 1}</span>
        <Play className="hidden size-4 text-accent group-hover:block" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{track.name}</span>
          <span className="block truncate text-xs text-zinc-400">{track.artists.join(', ')}</span>
        </span>
        <span className="text-xs text-zinc-500 tabular-nums">{fmtDuration(track.durationSec)}</span>
      </button>
    </li>
  );
}
