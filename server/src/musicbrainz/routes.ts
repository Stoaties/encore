import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  normalizeForMatch,
  type MbArtistDetail,
  type MbRecordingResult,
  type MbReleaseGroupResult,
  type MbSearchResults,
} from '@encore/shared';
import type { AppDeps } from '../app.js';
import { jfContext } from '../auth/session.js';
import { ITEM_FIELDS } from '../jellyfin/mappers.js';
import { openRequestMbids } from '../requests/service.js';
import type { JfItem } from '../jellyfin/client.js';

/** Album/EP with no secondary type (live, compilation, remix…) counts as discography. */
export function isDiscographyEntry(rg: MbReleaseGroupResult): boolean {
  return (rg.primaryType === 'Album' || rg.primaryType === 'EP') && rg.secondaryTypes.length === 0;
}

const albumKey = (artist: string, title: string) => `${normalizeForMatch(artist)}|${normalizeForMatch(title)}`;

function libraryAlbumKeys(items: JfItem[]): { keys: Set<string>; rgMbids: Set<string> } {
  const keys = new Set<string>();
  const rgMbids = new Set<string>();
  for (const item of items) {
    const rgId = item.ProviderIds?.MusicBrainzReleaseGroup;
    if (rgId) rgMbids.add(rgId);
    const artists = [item.AlbumArtist, ...(item.AlbumArtists?.map((a) => a.Name) ?? [])].filter((a): a is string => !!a);
    for (const a of artists) keys.add(albumKey(a, item.Name));
  }
  return { keys, rgMbids };
}

function markAlbum(rg: MbReleaseGroupResult, lib: ReturnType<typeof libraryAlbumKeys>, requested: Set<string>): MbReleaseGroupResult {
  return {
    ...rg,
    inLibrary: lib.rgMbids.has(rg.mbid) || lib.keys.has(albumKey(rg.artistName, rg.title)),
    requested: requested.has(rg.mbid),
  };
}

export function mbRoutes(deps: AppDeps) {
  const { mb, jellyfin, db } = deps;
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', app.authenticate);

    app.get('/search', async (req): Promise<MbSearchResults> => {
      const { q } = z.object({ q: z.string().min(1).max(200) }).parse(req.query);
      const { token, jfUserId } = await jfContext(db, req.user.sub);

      const [artists, releaseGroups, recordings, open, jfAlbums, jfTracks] = await Promise.all([
        mb.searchArtists(q),
        mb.searchReleaseGroups(q),
        mb.searchRecordings(q),
        openRequestMbids(db),
        jellyfin.items(token, {
          userId: jfUserId,
          IncludeItemTypes: 'MusicAlbum',
          Recursive: true,
          SearchTerm: q,
          Limit: 40,
          Fields: ITEM_FIELDS,
        }),
        jellyfin.items(token, {
          userId: jfUserId,
          IncludeItemTypes: 'Audio',
          Recursive: true,
          SearchTerm: q,
          Limit: 80,
          Fields: ITEM_FIELDS,
        }),
      ]);

      const lib = libraryAlbumKeys(jfAlbums.Items);
      const trackKeys = new Set<string>();
      for (const t of jfTracks.Items) {
        const artists = [t.AlbumArtist, ...(t.Artists ?? [])].filter((a): a is string => !!a);
        for (const a of artists) trackKeys.add(albumKey(a, t.Name));
      }

      const markTrack = (r: MbRecordingResult): MbRecordingResult => ({
        ...r,
        inLibrary: trackKeys.has(albumKey(r.artistName, r.title)),
        requested: open.recordings.has(r.mbid),
      });

      return {
        artists: artists.map((a) => ({ ...a })),
        releaseGroups: releaseGroups.map((rg) => markAlbum(rg, lib, open.releaseGroups)),
        recordings: recordings.map(markTrack),
      };
    });

    app.get('/artist/:mbid', async (req): Promise<MbArtistDetail> => {
      const { mbid } = z.object({ mbid: z.string().uuid() }).parse(req.params);
      const { token, jfUserId } = await jfContext(db, req.user.sub);

      const [artist, allReleaseGroups, open] = await Promise.all([
        mb.lookupArtist(mbid),
        mb.artistReleaseGroups(mbid),
        openRequestMbids(db),
      ]);
      const releaseGroups = allReleaseGroups
        .filter(isDiscographyEntry)
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

      // find the artist's albums in Jellyfin (by name match) to badge inLibrary
      let lib: ReturnType<typeof libraryAlbumKeys> = { keys: new Set(), rgMbids: new Set() };
      const jfArtists = await jellyfin.albumArtists(token, {
        userId: jfUserId,
        SearchTerm: artist.name,
        Limit: 3,
      });
      const jfArtist = jfArtists.Items.find((a) => normalizeForMatch(a.Name) === normalizeForMatch(artist.name));
      if (jfArtist) {
        const albums = await jellyfin.items(token, {
          userId: jfUserId,
          IncludeItemTypes: 'MusicAlbum',
          AlbumArtistIds: jfArtist.Id,
          Recursive: true,
          Limit: 200,
          Fields: ITEM_FIELDS,
        });
        lib = libraryAlbumKeys(albums.Items);
      }

      return {
        artist,
        releaseGroups: releaseGroups.map((rg) => markAlbum(rg, lib, open.releaseGroups)),
      };
    });
  };
}
