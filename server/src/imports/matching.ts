import { normalizeForMatch, type MatchStatus, type MbRecordingResult } from '@encore/shared';
import type { MusicBrainzClient } from '../musicbrainz/client.js';
import type { SourceTrack } from './providers.js';

export interface MatchResult {
  recording: MbRecordingResult | null;
  score: number;
  status: Exclude<MatchStatus, 'confirmed' | 'rejected'>;
}

const AUTO_THRESHOLD = 0.8;
const REVIEW_THRESHOLD = 0.45;

const tokens = (s: string): Set<string> => new Set(normalizeForMatch(s).split(' ').filter(Boolean));

/** 1 for an exact (normalized) match, 0.85 for containment, else token Jaccard. */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = tokens(a);
  const tb = tokens(b);
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const union = ta.size + tb.size - common;
  return union ? common / union : 0;
}

export function scoreMatch(src: SourceTrack, rec: Pick<MbRecordingResult, 'title' | 'artistName' | 'durationMs'>): number {
  const titleSim = nameSimilarity(src.title, rec.title);
  const artistSim = src.artist ? nameSimilarity(src.artist, rec.artistName) : null;
  const durSim =
    src.durationMs && rec.durationMs
      ? Math.max(0, 1 - Math.abs(src.durationMs - rec.durationMs) / 15_000)
      : null;
  let score = 0;
  let weight = 0;
  const add = (sim: number | null, w: number) => {
    if (sim !== null) {
      score += sim * w;
      weight += w;
    }
  };
  add(titleSim, 0.5);
  add(artistSim, 0.3);
  add(durSim, 0.2);
  return weight ? score / weight : 0;
}

export function classify(score: number): MatchResult['status'] {
  if (score >= AUTO_THRESHOLD) return 'auto';
  if (score >= REVIEW_THRESHOLD) return 'needs_review';
  return 'unmatched';
}

const luceneQuote = (s: string) => `"${s.replace(/["\\]/g, ' ').trim()}"`;

/** Finds the best MusicBrainz recording for a source track (MB calls are rate limited upstream). */
export async function matchSourceTrack(mb: MusicBrainzClient, src: SourceTrack): Promise<MatchResult> {
  const queries = [
    src.artist ? `recording:${luceneQuote(src.title)} AND artist:${luceneQuote(src.artist)}` : null,
    `${src.artist ?? ''} ${src.title}`.trim(),
  ].filter((q): q is string => !!q);

  let best: { recording: MbRecordingResult; score: number } | null = null;
  let lastError: unknown = null;
  for (const q of queries) {
    const results = await mb.searchRecordings(q, 8).catch((err: unknown) => {
      lastError = err;
      return [] as MbRecordingResult[];
    });
    for (const rec of results) {
      const score = scoreMatch(src, rec);
      if (!best || score > best.score) best = { recording: rec, score };
    }
    if (best && best.score >= AUTO_THRESHOLD) break;
  }
  if (!best) {
    // a transient MB failure must not masquerade as a definitive "no match"
    if (lastError) throw lastError;
    return { recording: null, score: 0, status: 'unmatched' };
  }
  const status = classify(best.score);
  return { recording: status === 'unmatched' ? null : best.recording, score: best.score, status };
}
