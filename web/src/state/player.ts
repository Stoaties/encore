import { create } from 'zustand';
import type { TrackSummary } from '@encore/shared';

export type RepeatMode = 'off' | 'all' | 'one';

interface PlayerState {
  queue: TrackSummary[];
  index: number;
  isPlaying: boolean;
  positionSec: number;
  durationSec: number;
  repeat: RepeatMode;
  volume: number;
  showQueue: boolean;
  setShowQueue: (v: boolean) => void;
}

export const usePlayer = create<PlayerState>()((set) => ({
  queue: [],
  index: -1,
  isPlaying: false,
  positionSec: 0,
  durationSec: 0,
  repeat: 'off',
  volume: 1,
  showQueue: false,
  setShowQueue: (showQueue) => set({ showQueue }),
}));

export const currentTrack = (s: Pick<PlayerState, 'queue' | 'index'>): TrackSummary | null =>
  s.index >= 0 && s.index < s.queue.length ? (s.queue[s.index] ?? null) : null;
