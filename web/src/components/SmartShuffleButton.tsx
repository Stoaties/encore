import { Sparkles } from 'lucide-react';
import type { TrackSummary } from '@encore/shared';
import { useSmartShuffle } from '../api/queries';
import { playQueue } from '../state/audio';

/** Reorders the given tracks server-side (plays/skips/favorites/recency) and plays them. */
export function SmartShuffleButton({ tracks }: { tracks: TrackSummary[] }) {
  const shuffle = useSmartShuffle();
  return (
    <button
      disabled={!tracks.length || shuffle.isPending}
      onClick={() =>
        shuffle.mutate(
          tracks.map((t) => t.id),
          {
            onSuccess: ({ order }) => {
              const byId = new Map(tracks.map((t) => [t.id, t]));
              const ordered = order.map((id) => byId.get(id)).filter((t): t is TrackSummary => !!t);
              playQueue(ordered, 0);
            },
          },
        )
      }
      className="flex items-center gap-2 rounded-full bg-panel-hover px-5 py-2 text-sm font-semibold hover:bg-zinc-700 disabled:opacity-50"
    >
      <Sparkles className="size-4" /> Smart shuffle
    </button>
  );
}
