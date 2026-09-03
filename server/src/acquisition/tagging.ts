import { ByteVector, File as TagLibFile, Picture, PictureType } from 'node-taglib-sharp';
import { caaCoverUrl } from '@encore/shared';

export class AudioVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioVerifyError';
  }
}

export interface TagInput {
  title: string;
  artists: string[];
  albumArtist: string;
  album: string;
  year?: number | null;
  trackNo: number;
  trackCount: number;
  discNo: number;
  discCount: number;
  mbRecordingId?: string | null;
  mbReleaseId?: string | null;
  mbReleaseGroupId?: string | null;
  mbArtistId?: string | null;
  cover?: { data: Uint8Array; mimeType: string } | null;
}

/** Opens the file with TagLib and sanity-checks that it decodes as audio. */
export function verifyAudio(path: string): { durationMs: number; bitrateKbps: number } {
  let f: TagLibFile | undefined;
  try {
    f = TagLibFile.createFromPath(path);
    const durationMs = f.properties?.durationMilliseconds ?? 0;
    if (!durationMs || durationMs < 1000) {
      throw new AudioVerifyError(`file has no decodable audio (duration ${Math.round(durationMs)}ms)`);
    }
    return { durationMs, bitrateKbps: f.properties?.audioBitrate ?? 0 };
  } catch (err) {
    if (err instanceof AudioVerifyError) throw err;
    throw new AudioVerifyError(`unreadable audio file: ${(err as Error).message}`);
  } finally {
    f?.dispose();
  }
}

/** Rewrites the file's tags from MusicBrainz data (clearing whatever the uploader left in). */
export function writeTags(path: string, tag: TagInput): void {
  const f = TagLibFile.createFromPath(path);
  try {
    f.tag.clear();
    f.tag.title = tag.title;
    f.tag.performers = tag.artists;
    f.tag.albumArtists = [tag.albumArtist];
    f.tag.album = tag.album;
    if (tag.year) f.tag.year = tag.year;
    f.tag.track = tag.trackNo;
    f.tag.trackCount = tag.trackCount;
    f.tag.disc = tag.discNo;
    f.tag.discCount = tag.discCount;
    if (tag.mbRecordingId) f.tag.musicBrainzTrackId = tag.mbRecordingId;
    if (tag.mbReleaseId) f.tag.musicBrainzReleaseId = tag.mbReleaseId;
    if (tag.mbReleaseGroupId) f.tag.musicBrainzReleaseGroupId = tag.mbReleaseGroupId;
    if (tag.mbArtistId) {
      f.tag.musicBrainzArtistId = tag.mbArtistId;
      f.tag.musicBrainzReleaseArtistId = tag.mbArtistId;
    }
    if (tag.cover) {
      f.tag.pictures = [
        Picture.fromFullData(
          ByteVector.fromByteArray(tag.cover.data),
          PictureType.FrontCover,
          tag.cover.mimeType,
          'Front cover',
        ),
      ];
    }
    f.save();
  } finally {
    f.dispose();
  }
}

/** Front cover from the Cover Art Archive; null when the release group has no art. */
export async function fetchCover(
  releaseGroupMbid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  try {
    const res = await fetchImpl(caaCoverUrl(releaseGroupMbid, 500), { redirect: 'follow' });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) return null;
    return { data: buf, mimeType: res.headers.get('content-type') ?? 'image/jpeg' };
  } catch {
    return null;
  }
}
