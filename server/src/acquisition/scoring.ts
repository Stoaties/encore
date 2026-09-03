import { normalizeForMatch, type MbTrack } from '@encore/shared';
import type { SlskdSearchFile, SlskdSearchResponse } from '../slskd/client.js';

export const AUDIO_EXTS = new Set(['flac', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'ape', 'wv', 'aiff', 'alac', 'wma']);
export const LOSSLESS_EXTS = new Set(['flac', 'wav', 'ape', 'wv', 'aiff', 'alac']);

export interface QualityPrefs {
  /** in preference order, best first */
  preferredFormats: string[];
  /** applies to lossy formats with a known bitrate */
  minBitrateKbps: number;
}

export interface AlbumCandidate {
  username: string;
  directory: string;
  score: number;
  format: string;
  mapping: { track: MbTrack; file: SlskdSearchFile }[];
  totalBytes: number;
}

export interface TrackCandidate {
  username: string;
  score: number;
  format: string;
  file: SlskdSearchFile;
  totalBytes: number;
}

// ---------- path helpers (soulseek paths are windows-style) ----------

const lastSep = (p: string): number => Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
export const baseOf = (p: string): string => p.slice(lastSep(p) + 1);
export const dirOf = (p: string): string => (lastSep(p) >= 0 ? p.slice(0, lastSep(p)) : '');
export const extOf = (p: string): string => {
  const base = baseOf(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/** Leading track (and optional disc) number of a file basename, e.g. "1-05 Title", "05. Title", "105 Title". */
export function parseTrackNo(basename: string): { disc: number | null; track: number } | null {
  const m = /^\s*(\d{1,3})(?:\s*[-._]\s*(\d{1,2}))?[\s\-._)]+\S/.exec(basename);
  if (!m) return null;
  const first = Number(m[1]);
  if (m[2] !== undefined) {
    const second = Number(m[2]);
    // "1-05" => disc 1 track 5 (but "05 - 3 AM" style means track 5, title starts with a number —
    // treat as disc-track only when the first number is a plausible disc)
    if (first <= 6 && m[1]!.length === 1) return { disc: first, track: second };
    return { disc: null, track: first };
  }
  if (first > 99) return { disc: Math.floor(first / 100), track: first % 100 }; // "105" => 1-05
  return { disc: null, track: first };
}

const DISC_DIR_RE = /^(?:cd|disc|disk|d)\s*[-_. ]?\s*(\d{1,2})$/i;

// ---------- shared scoring bits ----------

const formatRank = (fmt: string, preferred: string[]): number => {
  const idx = preferred.findIndex((f) => f.toLowerCase() === fmt);
  return idx < 0 ? -1 : (preferred.length - idx) / preferred.length; // 1.0 = most preferred
};

type Peer = Pick<SlskdSearchResponse, 'hasFreeUploadSlot' | 'queueLength' | 'uploadSpeed'>;
const peerScore = (r: Peer): number =>
  (r.hasFreeUploadSlot ? 120 : 0) - r.queueLength * 15 + Math.min((r.uploadSpeed ?? 0) / 50_000, 40);

const bitrateOk = (file: SlskdSearchFile, fmt: string, prefs: QualityPrefs): boolean =>
  LOSSLESS_EXTS.has(fmt) || file.bitRate == null || file.bitRate >= prefs.minBitrateKbps;

const bitrateBonus = (fmt: string, avgBitrate: number | null): number => {
  if (LOSSLESS_EXTS.has(fmt) || avgBitrate == null) return 0;
  return avgBitrate >= 320 ? 30 : avgBitrate >= 256 ? 15 : 0;
};

const durationScore = (fileLenSec: number | null | undefined, wantMs: number | null | undefined, scale: { close: number; near: number; far: number }): number => {
  if (!fileLenSec || !wantMs) return 0;
  const diff = Math.abs(fileLenSec - wantMs / 1000);
  if (diff <= 5) return scale.close;
  if (diff <= 15) return scale.near;
  if (diff > 30) return scale.far;
  return 0;
};

// ---------- album candidates ----------

interface FileWithDisc {
  file: SlskdSearchFile;
  /** disc inferred from a CD1/CD2-style parent folder */
  folderDisc: number | null;
}

/**
 * Maps folder files onto the MusicBrainz tracklist: by track number first,
 * then by title, then positionally when the folder has no numbering at all.
 */
export function matchAlbumFiles(
  files: FileWithDisc[],
  tracks: MbTrack[],
  discCount: number,
): { mapping: { track: MbTrack; file: SlskdSearchFile }[]; matchScore: number } {
  const sorted = [...files].sort((a, b) => baseOf(a.file.filename).localeCompare(baseOf(b.file.filename)));
  const used = new Set<FileWithDisc>();
  const mapping: { track: MbTrack; file: SlskdSearchFile }[] = [];
  let matchScore = 0;

  const parsed = sorted.map((f) => ({ f, no: parseTrackNo(baseOf(f.file.filename)) }));
  const anyNumbers = parsed.some((p) => p.no !== null);

  for (const track of tracks) {
    const wantTitle = normalizeForMatch(track.title);
    let picked: FileWithDisc | undefined;
    let pickedBonus = 0;

    if (anyNumbers) {
      const numbered = parsed.filter(({ f, no }) => {
        if (used.has(f) || no === null || no.track !== track.position) return false;
        if (discCount <= 1) return true;
        const disc = f.folderDisc ?? no.disc;
        return disc === null || disc === track.disc;
      });
      picked =
        numbered.find(({ f }) => normalizeForMatch(baseOf(f.file.filename)).includes(wantTitle))?.f ??
        numbered[0]?.f;
      if (picked) {
        pickedBonus += 2;
        if (normalizeForMatch(baseOf(picked.file.filename)).includes(wantTitle)) pickedBonus += 3;
      }
    }
    if (!picked && wantTitle.length >= 3) {
      picked = parsed.find(
        ({ f }) => !used.has(f) && normalizeForMatch(baseOf(f.file.filename)).includes(wantTitle),
      )?.f;
      if (picked) pickedBonus += 3;
    }
    if (!picked && !anyNumbers && files.length === tracks.length) {
      picked = sorted.find((f) => !used.has(f));
      if (picked) pickedBonus += 1;
    }
    if (!picked) continue;

    used.add(picked);
    matchScore += pickedBonus + durationScore(picked.file.length, track.durationMs, { close: 3, near: 1, far: -2 });
    mapping.push({ track, file: picked.file });
  }
  return { mapping, matchScore };
}

export function scoreAlbumCandidates(
  responses: SlskdSearchResponse[],
  target: { artistName: string; albumTitle: string; tracks: MbTrack[]; discCount: number },
  prefs: QualityPrefs,
): AlbumCandidate[] {
  const wantArtist = normalizeForMatch(target.artistName);
  const wantAlbum = normalizeForMatch(target.albumTitle);
  const out: AlbumCandidate[] = [];

  for (const resp of responses) {
    const audio = resp.files.filter((f) => AUDIO_EXTS.has(extOf(f.filename)));
    if (!audio.length) continue;

    // group per directory, then merge CD1/CD2-style sibling folders into their parent
    const byDir = new Map<string, SlskdSearchFile[]>();
    for (const f of audio) {
      const d = dirOf(f.filename);
      byDir.set(d, [...(byDir.get(d) ?? []), f]);
    }
    const groups = new Map<string, FileWithDisc[]>();
    for (const [dir, files] of byDir) {
      const discMatch = DISC_DIR_RE.exec(baseOf(dir));
      const key = discMatch ? dirOf(dir) : dir;
      const folderDisc = discMatch ? Number(discMatch[1]) : null;
      groups.set(key, [...(groups.get(key) ?? []), ...files.map((file) => ({ file, folderDisc }))]);
    }

    for (const [directory, files] of groups) {
      const counts = new Map<string, number>();
      for (const f of files) counts.set(extOf(f.file.filename), (counts.get(extOf(f.file.filename)) ?? 0) + 1);
      const format = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      const rank = formatRank(format, prefs.preferredFormats);
      if (rank < 0) continue;

      const main = files.filter((f) => extOf(f.file.filename) === format);
      if (!main.every((f) => bitrateOk(f.file, format, prefs))) continue;

      const { mapping, matchScore } = matchAlbumFiles(main, target.tracks, target.discCount);
      if (mapping.length < target.tracks.length) continue;

      const dirNorm = normalizeForMatch(directory);
      const nameBonus = (wantAlbum && dirNorm.includes(wantAlbum) ? 60 : 0) + (wantArtist && dirNorm.includes(wantArtist) ? 30 : 0);
      const known = main.map((f) => f.file.bitRate).filter((b): b is number => b != null);
      const avgBitrate = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
      const extras = main.length - target.tracks.length;

      out.push({
        username: resp.username,
        directory,
        format,
        mapping,
        totalBytes: mapping.reduce((a, m) => a + m.file.size, 0),
        score:
          rank * 400 +
          peerScore(resp) +
          matchScore * 8 +
          nameBonus +
          bitrateBonus(format, avgBitrate) -
          Math.min(Math.max(extras, 0), 20) * 2,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------- track candidates ----------

export function scoreTrackCandidates(
  responses: SlskdSearchResponse[],
  target: { artistName: string; title: string; durationMs?: number | null },
  prefs: QualityPrefs,
): TrackCandidate[] {
  const wantTitle = normalizeForMatch(target.title);
  const wantArtist = normalizeForMatch(target.artistName);
  const out: TrackCandidate[] = [];

  for (const resp of responses) {
    for (const file of resp.files) {
      const format = extOf(file.filename);
      if (!AUDIO_EXTS.has(format)) continue;
      const rank = formatRank(format, prefs.preferredFormats);
      if (rank < 0) continue;
      if (!bitrateOk(file, format, prefs)) continue;

      const pathNorm = normalizeForMatch(file.filename);
      const titleMatch = wantTitle.length >= 3 && pathNorm.includes(wantTitle);
      const dur = durationScore(file.length, target.durationMs, { close: 60, near: 30, far: -60 });
      if (!titleMatch && dur <= 0) continue; // nothing ties this file to the track

      out.push({
        username: resp.username,
        file,
        format,
        totalBytes: file.size,
        score:
          rank * 400 +
          peerScore(resp) +
          (titleMatch ? 80 : 0) +
          (wantArtist && pathNorm.includes(wantArtist) ? 30 : 0) +
          dur +
          bitrateBonus(format, file.bitRate ?? null),
      });
    }
  }
  // one candidate per peer (like album candidates): when a transfer fails, the
  // retry must move to a different source, not another file on the same dead peer
  const bestByPeer = new Map<string, TrackCandidate>();
  for (const c of out) {
    const cur = bestByPeer.get(c.username);
    if (!cur || c.score > cur.score) bestByPeer.set(c.username, c);
  }
  return [...bestByPeer.values()].sort((a, b) => b.score - a.score).slice(0, 10);
}
