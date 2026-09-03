import { describe, expect, it } from 'vitest';
import { smartShuffle, trackWeight, type ShuffleWeights, type TrackStats } from '../src/shuffle/smart.js';

const W: ShuffleWeights = { playCountWeight: 0.5, favoriteBoost: 2, skipPenalty: 3, recencyHours: 48, recencyPenalty: 2 };
const NOW = new Date('2026-08-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('trackWeight', () => {
  it('is 1 for a track with no history', () => {
    expect(trackWeight(undefined, false, W, NOW)).toBe(1);
    expect(trackWeight({ plays: 0, skips: 0 }, false, W, NOW)).toBe(1);
  });

  it('grows logarithmically with completed plays', () => {
    const w1 = trackWeight({ plays: 1, skips: 0 }, false, W, NOW);
    const w3 = trackWeight({ plays: 3, skips: 0 }, false, W, NOW);
    const w7 = trackWeight({ plays: 7, skips: 0 }, false, W, NOW);
    expect(w1).toBeCloseTo(1 + 0.5 * Math.log2(2));
    // log growth: each doubling of (1+plays) adds the same amount
    expect(w3 - w1).toBeCloseTo(w7 - w3, 5);
  });

  it('adds the favorite boost', () => {
    expect(trackWeight(undefined, true, W, NOW)).toBe(1 + W.favoriteBoost);
  });

  it('penalizes skips', () => {
    expect(trackWeight({ plays: 0, skips: 1 }, false, W, NOW)).toBeCloseTo(Math.max(0.05, 1 - 3 * Math.log2(2)));
  });

  it('never goes below the floor', () => {
    expect(trackWeight({ plays: 0, skips: 100 }, false, W, NOW)).toBe(0.05);
  });

  it('halves-ish recently played tracks, fading with age', () => {
    const fresh = trackWeight({ plays: 0, skips: 0, lastPlayedAt: hoursAgo(0) }, false, W, NOW);
    const mid = trackWeight({ plays: 0, skips: 0, lastPlayedAt: hoursAgo(24) }, false, W, NOW);
    const old = trackWeight({ plays: 0, skips: 0, lastPlayedAt: hoursAgo(49) }, false, W, NOW);
    expect(fresh).toBeCloseTo(1 / 3); // 1 / (1 + 2·1)
    expect(mid).toBeCloseTo(1 / 2); // 1 / (1 + 2·0.5)
    expect(old).toBe(1); // outside the window
    expect(fresh).toBeLessThan(mid);
  });

  it('ignores recency when the window is disabled', () => {
    const w = { ...W, recencyHours: 0 };
    expect(trackWeight({ plays: 0, skips: 0, lastPlayedAt: hoursAgo(1) }, false, w, NOW)).toBe(1);
  });
});

describe('smartShuffle', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('returns a permutation of the input', () => {
    const out = smartShuffle(ids, new Map(), new Set(), W);
    expect([...out].sort()).toEqual([...ids].sort());
  });

  it('is deterministic given a seeded rng', () => {
    const rng = (seq: number[]) => {
      let i = 0;
      return () => seq[i++ % seq.length]!;
    };
    const a = smartShuffle(ids, new Map(), new Set(), W, { now: NOW, rng: rng([0.9, 0.1, 0.5, 0.3]) });
    const b = smartShuffle(ids, new Map(), new Set(), W, { now: NOW, rng: rng([0.9, 0.1, 0.5, 0.3]) });
    expect(a).toEqual(b);
  });

  it('ranks favorites ahead of skipped tracks with the same rng draw', () => {
    // identical uniform draws isolate the weight: higher weight ⇒ higher key
    const stats = new Map<string, TrackStats>([['skipped', { plays: 0, skips: 5 }]]);
    const out = smartShuffle(['skipped', 'fav'], stats, new Set(['fav']), W, { now: NOW, rng: () => 0.5 });
    expect(out).toEqual(['fav', 'skipped']);
  });

  it('puts heavier tracks first far more often than not', () => {
    let favFirst = 0;
    const runs = 500;
    for (let i = 0; i < runs; i++) {
      const out = smartShuffle(['fav', 'meh'], new Map(), new Set(['fav']), W);
      if (out[0] === 'fav') favFirst++;
    }
    expect(favFirst).toBeGreaterThan(runs * 0.6); // weight 3 vs 1 ⇒ E[fav first] = 75%
    expect(favFirst).toBeLessThan(runs); // but never deterministic
  });
});
