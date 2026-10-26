import { useState } from 'react';
import type { MusicRequest } from '@encore/shared';
import { useYoutubeCandidates, usePickYoutube } from '../api/queries';
import { fmtDuration } from '../lib/format';

/**
 * Modal that lists the top ~10 YouTube search results for a track request so the
 * user can pick exactly which video to download — used when the automatic match
 * is wrong or a song isn't the top search result.
 */
export function YoutubePicker({ request, onClose }: { request: MusicRequest; onClose: () => void }) {
  const initial = `${request.artistName} ${request.trackTitle ?? ''}`.trim();
  const [query, setQuery] = useState(initial);
  const [submitted, setSubmitted] = useState(initial);
  const { data: candidates, isFetching, error } = useYoutubeCandidates(request.id, submitted, true);
  const pick = usePickYoutube();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-white/10 bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-white/10 p-4">
          <h2 className="text-lg font-semibold">Choose the right YouTube video</h2>
          <p className="mt-0.5 truncate text-xs text-zinc-400">
            {request.artistName} — {request.trackTitle}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(query);
            }}
            className="mt-3 flex gap-2"
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 rounded bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-emerald-500"
              placeholder="Search YouTube…"
            />
            <button type="submit" className="rounded bg-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-600">
              Search
            </button>
          </form>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {isFetching && <p className="p-4 text-center text-sm text-zinc-400">Searching YouTube…</p>}
          {error && <p className="p-4 text-center text-sm text-red-400">{(error as Error).message}</p>}
          {!isFetching && candidates && candidates.length === 0 && (
            <p className="p-4 text-center text-sm text-zinc-400">No results.</p>
          )}
          {candidates?.map((c) => (
            <div key={c.videoId} className="flex items-center gap-3 rounded p-2 hover:bg-white/5">
              <div className="h-12 w-20 shrink-0 overflow-hidden rounded bg-zinc-800">
                {c.thumbnail && <img src={c.thumbnail} alt="" className="h-full w-full object-cover" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{c.title}</p>
                <p className="truncate text-xs text-zinc-400">
                  {c.channel}
                  {c.durationSec ? ` · ${fmtDuration(c.durationSec)}` : ''}
                </p>
              </div>
              <button
                disabled={pick.isPending}
                onClick={() => pick.mutate({ id: request.id, videoId: c.videoId }, { onSuccess: onClose })}
                className="shrink-0 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium hover:bg-emerald-500 disabled:opacity-50"
              >
                Choose
              </button>
            </div>
          ))}
        </div>

        <div className="border-t border-white/10 p-3 text-right">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-zinc-400 hover:text-white">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
