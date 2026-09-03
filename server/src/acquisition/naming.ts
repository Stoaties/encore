import type { MbTrack, MbTracklist } from '@encore/shared';

/** Makes a string safe as a single path component on Linux/Windows/NAS filesystems. */
export function sanitizePathPart(s: string): string {
  const cleaned = s
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^\.+/, '');
  const capped = cleaned.length > 120 ? cleaned.slice(0, 120).trimEnd() : cleaned;
  return capped || '_';
}

export const pad2 = (n: number): string => String(n).padStart(2, '0');

/** [artistDir, albumDir] under the library root. */
export function albumDirParts(t: Pick<MbTracklist, 'artistName' | 'title' | 'isVariousArtists'>): [string, string] {
  return [sanitizePathPart(t.isVariousArtists ? 'Various Artists' : t.artistName), sanitizePathPart(t.title)];
}

/**
 * `<track> - <title>.<ext>`, with a disc prefix for multi-disc releases and the
 * track artist inlined for various-artists releases.
 */
export function trackFileName(
  track: Pick<MbTrack, 'disc' | 'position' | 'title' | 'artistName'>,
  opts: { discCount: number; isVariousArtists: boolean; ext: string },
): string {
  const prefix = opts.discCount > 1 ? `${track.disc}-${pad2(track.position)}` : pad2(track.position);
  const artist = opts.isVariousArtists ? `${track.artistName} - ` : '';
  return sanitizePathPart(`${prefix} - ${artist}${track.title}`) + `.${opts.ext.toLowerCase()}`;
}
