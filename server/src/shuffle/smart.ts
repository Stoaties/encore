import type { AppSettings } from '@encore/shared';

/**
 * Smart shuffle: weighted random ordering of a candidate queue.
 *
 * Each track gets a weight, then the queue is ordered by weighted sampling
 * without replacement (Efraimidis–Spirakis: key = rand^(1/weight), sort desc),
 * so heavier tracks *tend* to come first but every order stays possible.
 *
 *   weight = 1
 *          + playCountWeight * log2(1 + completedPlays)   // familiarity
 *          + favoriteBoost   (if favorited in Jellyfin)
 *          - skipPenalty     * log2(1 + skips)            // dislike signal
 *   played within the last `recencyHours`:
 *          weight /= 1 + recencyPenalty * (1 - age/recencyHours)  // avoid repeats
 *   floor: 0.05 so nothing is ever fully excluded.
 *
 * All knobs live in settings.shuffle.
 */

export interface TrackStats {
  plays: number;
  skips: number;
  lastPlayedAt?: Date | null;
}

export type ShuffleWeights = AppSettings['shuffle'];

export function trackWeight(
  stats: TrackStats | undefined,
  isFavorite: boolean,
  w: ShuffleWeights,
  now: Date = new Date(),
): number {
  let weight = 1;
  const plays = stats?.plays ?? 0;
  const skips = stats?.skips ?? 0;
  weight += w.playCountWeight * Math.log2(1 + plays);
  if (isFavorite) weight += w.favoriteBoost;
  weight -= w.skipPenalty * Math.log2(1 + skips);
  if (stats?.lastPlayedAt && w.recencyHours > 0) {
    const ageHours = (now.getTime() - stats.lastPlayedAt.getTime()) / 3_600_000;
    if (ageHours >= 0 && ageHours < w.recencyHours) {
      weight /= 1 + w.recencyPenalty * (1 - ageHours / w.recencyHours);
    }
  }
  return Math.max(0.05, weight);
}

export function smartShuffle(
  itemIds: string[],
  statsById: Map<string, TrackStats>,
  favorites: Set<string>,
  weights: ShuffleWeights,
  opts: { now?: Date; rng?: () => number } = {},
): string[] {
  const now = opts.now ?? new Date();
  const rng = opts.rng ?? Math.random;
  return itemIds
    .map((id) => {
      const w = trackWeight(statsById.get(id), favorites.has(id), weights, now);
      return { id, key: Math.pow(rng(), 1 / w) };
    })
    .sort((a, b) => b.key - a.key)
    .map((e) => e.id);
}
