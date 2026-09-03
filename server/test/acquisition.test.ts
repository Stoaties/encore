import { describe, expect, it } from 'vitest';
import type { MbTrack } from '@encore/shared';
import { albumDirParts, sanitizePathPart, trackFileName } from '../src/acquisition/naming.js';
import {
  matchAlbumFiles,
  parseTrackNo,
  scoreAlbumCandidates,
  scoreTrackCandidates,
  type QualityPrefs,
} from '../src/acquisition/scoring.js';
import type { SlskdSearchFile, SlskdSearchResponse } from '../src/slskd/client.js';

const prefs: QualityPrefs = { preferredFormats: ['flac', 'mp3'], minBitrateKbps: 192 };

const file = (filename: string, over: Partial<SlskdSearchFile> = {}): SlskdSearchFile => ({
  filename,
  size: 10_000_000,
  ...over,
});

const resp = (
  username: string,
  files: SlskdSearchFile[],
  over: Partial<SlskdSearchResponse> = {},
): SlskdSearchResponse => ({
  username,
  hasFreeUploadSlot: true,
  queueLength: 0,
  uploadSpeed: 100_000,
  files,
  ...over,
});

const mkTracks = (titles: string[], disc = 1): MbTrack[] =>
  titles.map((title, i) => ({
    disc,
    position: i + 1,
    title,
    artistName: 'Tester',
    recordingMbid: `rec-${disc}-${i + 1}`,
    durationMs: 200_000,
  }));

// ---------- naming ----------

describe('naming', () => {
  it('sanitizes filesystem-unsafe characters', () => {
    expect(sanitizePathPart('AC/DC')).toBe('AC_DC');
    expect(sanitizePathPart('What Now?')).toBe('What Now_');
    expect(sanitizePathPart('a: b* c|d "e" <f>')).toBe('a_ b_ c_d _e_ _f_');
    expect(sanitizePathPart('  trailing dots... ')).toBe('trailing dots');
    expect(sanitizePathPart('...')).toBe('_');
    expect(sanitizePathPart('x'.repeat(300)).length).toBeLessThanOrEqual(120);
  });

  it('builds track filenames', () => {
    const t = { disc: 1, position: 3, title: 'Karma Police', artistName: 'Radiohead' };
    expect(trackFileName(t, { discCount: 1, isVariousArtists: false, ext: 'FLAC' })).toBe('03 - Karma Police.flac');
    expect(trackFileName({ ...t, disc: 2, position: 4 }, { discCount: 2, isVariousArtists: false, ext: 'mp3' })).toBe(
      '2-04 - Karma Police.mp3',
    );
    expect(trackFileName(t, { discCount: 1, isVariousArtists: true, ext: 'flac' })).toBe(
      '03 - Radiohead - Karma Police.flac',
    );
  });

  it('handles various-artists album dirs', () => {
    expect(albumDirParts({ artistName: 'Someone', title: 'Now 100', isVariousArtists: true })).toEqual([
      'Various Artists',
      'Now 100',
    ]);
  });
});

// ---------- track number parsing ----------

describe('parseTrackNo', () => {
  it('parses common numbering styles', () => {
    expect(parseTrackNo('01 - Foo.flac')).toEqual({ disc: null, track: 1 });
    expect(parseTrackNo('12. Bar.mp3')).toEqual({ disc: null, track: 12 });
    expect(parseTrackNo('1-05 Foo.flac')).toEqual({ disc: 1, track: 5 });
    expect(parseTrackNo('105 Foo.flac')).toEqual({ disc: 1, track: 5 });
    expect(parseTrackNo('05 - 3 AM.flac')).toEqual({ disc: null, track: 5 });
    expect(parseTrackNo('No numbers.flac')).toBeNull();
  });
});

// ---------- album file matching ----------

describe('matchAlbumFiles', () => {
  it('maps by leading track number even when titles differ', () => {
    const tracks = mkTracks(['Alpha', 'Bravo', 'Charlie']);
    const files = ['01 - first.flac', '02 - second.flac', '03 - third.flac'].map((n) => ({
      file: file(`dir\\${n}`),
      folderDisc: null,
    }));
    const { mapping } = matchAlbumFiles(files, tracks, 1);
    expect(mapping).toHaveLength(3);
    expect(mapping.map((m) => m.track.position)).toEqual([1, 2, 3]);
    expect(mapping[0]!.file.filename).toContain('01');
  });

  it('falls back to title matching when numbering is absent', () => {
    const tracks = mkTracks(['Alpha', 'Bravo']);
    const files = ['Bravo.flac', 'Alpha.flac'].map((n) => ({ file: file(`dir\\${n}`), folderDisc: null }));
    const { mapping } = matchAlbumFiles(files, tracks, 1);
    expect(mapping).toHaveLength(2);
    expect(mapping.find((m) => m.track.title === 'Alpha')!.file.filename).toContain('Alpha');
  });

  it('never maps the same file twice', () => {
    const tracks = mkTracks(['Alpha', 'Bravo', 'Charlie']);
    const files = ['01 x.flac', '02 x.flac'].map((n) => ({ file: file(`dir\\${n}`), folderDisc: null }));
    const { mapping } = matchAlbumFiles(files, tracks, 1);
    expect(mapping).toHaveLength(2);
    expect(new Set(mapping.map((m) => m.file.filename)).size).toBe(2);
  });
});

// ---------- album candidate scoring ----------

describe('scoreAlbumCandidates', () => {
  const target = {
    artistName: 'Tester',
    albumTitle: 'Great Album',
    tracks: mkTracks(['Alpha', 'Bravo', 'Charlie']),
    discCount: 1,
  };
  const folder = (user: string, ext: string, over: Partial<SlskdSearchFile> = {}) =>
    ['01 - Alpha', '02 - Bravo', '03 - Charlie'].map((n) =>
      file(`share\\Tester\\Great Album\\${n}.${ext}`, over),
    );

  it('prefers the configured best format', () => {
    const cands = scoreAlbumCandidates(
      [resp('mp3guy', folder('mp3guy', 'mp3', { bitRate: 320 })), resp('flacguy', folder('flacguy', 'flac'))],
      target,
      prefs,
    );
    expect(cands.length).toBe(2);
    expect(cands[0]!.username).toBe('flacguy');
    expect(cands[0]!.format).toBe('flac');
  });

  it('rejects folders missing tracks and formats outside preferences', () => {
    const cands = scoreAlbumCandidates(
      [
        resp('partial', folder('partial', 'flac').slice(0, 2)),
        resp('ogguy', folder('ogguy', 'ogg')),
      ],
      target,
      prefs,
    );
    expect(cands).toHaveLength(0);
  });

  it('rejects lossy folders below the minimum bitrate', () => {
    const cands = scoreAlbumCandidates([resp('lowrate', folder('lowrate', 'mp3', { bitRate: 128 }))], target, prefs);
    expect(cands).toHaveLength(0);
  });

  it('prefers peers with a free upload slot', () => {
    const cands = scoreAlbumCandidates(
      [
        resp('queued', folder('queued', 'flac'), { hasFreeUploadSlot: false, queueLength: 10 }),
        resp('open', folder('open', 'flac')),
      ],
      target,
      prefs,
    );
    expect(cands[0]!.username).toBe('open');
  });

  it('merges CD1/CD2 subfolders into one multi-disc candidate', () => {
    const tracks = [...mkTracks(['Alpha', 'Bravo']), ...mkTracks(['Charlie', 'Delta'], 2)];
    const files = [
      file('share\\Box\\CD1\\01 - Alpha.flac'),
      file('share\\Box\\CD1\\02 - Bravo.flac'),
      file('share\\Box\\CD2\\01 - Charlie.flac'),
      file('share\\Box\\CD2\\02 - Delta.flac'),
    ];
    const cands = scoreAlbumCandidates(
      [resp('boxguy', files)],
      { artistName: 'Tester', albumTitle: 'Box', tracks, discCount: 2 },
      prefs,
    );
    expect(cands).toHaveLength(1);
    expect(cands[0]!.mapping).toHaveLength(4);
    expect(cands[0]!.mapping.find((m) => m.track.disc === 2 && m.track.position === 1)!.file.filename).toContain(
      'Charlie',
    );
  });
});

// ---------- track candidate scoring ----------

describe('scoreTrackCandidates', () => {
  const target = { artistName: 'Radiohead', title: 'Karma Police', durationMs: 261_000 };

  it('requires a title (or duration) tie to the requested track', () => {
    const cands = scoreTrackCandidates(
      [resp('rando', [file('share\\Unrelated Song.flac'), file('share\\Radiohead - Karma Police.flac')])],
      target,
      prefs,
    );
    expect(cands).toHaveLength(1);
    expect(cands[0]!.file.filename).toContain('Karma Police');
  });

  it('ranks close duration matches above mismatches', () => {
    const cands = scoreTrackCandidates(
      [
        resp('a', [file('x\\Karma Police.flac', { length: 90 })]),
        resp('b', [file('y\\Karma Police.flac', { length: 262 })]),
      ],
      target,
      prefs,
    );
    expect(cands[0]!.username).toBe('b');
  });

  it('prefers better formats and enforces bitrate on lossy files', () => {
    const cands = scoreTrackCandidates(
      [
        resp('mp3guy', [file('x\\Karma Police.mp3', { bitRate: 320 })]),
        resp('flacguy', [file('y\\Karma Police.flac')]),
        resp('lowguy', [file('z\\Karma Police.mp3', { bitRate: 96 })]),
      ],
      target,
      prefs,
    );
    expect(cands.map((c) => c.username)).toEqual(['flacguy', 'mp3guy']);
  });

  it('keeps only the best file per peer so retries move to other sources', () => {
    const fast = resp(
      'fast_but_dead',
      [
        file('a\\01 - Karma Police Track 01.flac'),
        file('a\\Karma Police.flac', { length: 261 }),
        file('a\\02 - Karma Police Track 02.flac'),
      ],
      { uploadSpeed: 5_000_000 },
    );
    const slow = resp('slowpoke', [file('b\\Karma Police.flac', { length: 261 })], { uploadSpeed: 100 });
    const cands = scoreTrackCandidates([fast, slow], target, prefs);
    expect(cands.map((c) => c.username)).toEqual(['fast_but_dead', 'slowpoke']);
    expect(cands[0]!.file.filename).toBe('a\\Karma Police.flac');
  });
});
