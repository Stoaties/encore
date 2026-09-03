import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  AlbumDetail,
  ArtistDetail,
  HomeData,
  Paged,
  ArtistSummary,
  AlbumSummary,
  SearchResults,
} from '@encore/shared';
import type { AppDeps } from '../app.js';
import { jfContext } from '../auth/session.js';
import { ITEM_FIELDS, toAlbumSummary, toArtistSummary, toTrackSummary } from '../jellyfin/mappers.js';

const PageQuery = z.object({
  start: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  search: z.string().optional(),
});

export function libraryRoutes(deps: AppDeps) {
  const { jellyfin } = deps;
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', app.authenticate);

    app.get('/home', async (req): Promise<HomeData> => {
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      const base = {
        userId: jfUserId,
        IncludeItemTypes: 'MusicAlbum',
        Recursive: true,
        Fields: ITEM_FIELDS,
        Limit: 12,
      };
      const [recent, random] = await Promise.all([
        jellyfin.items(token, { ...base, SortBy: 'DateCreated', SortOrder: 'Descending' }),
        jellyfin.items(token, { ...base, SortBy: 'Random' }),
      ]);
      return {
        recentlyAdded: recent.Items.map(toAlbumSummary),
        random: random.Items.map(toAlbumSummary),
      };
    });

    app.get('/artists', async (req): Promise<Paged<ArtistSummary>> => {
      const q = PageQuery.parse(req.query);
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      const res = await jellyfin.albumArtists(token, {
        userId: jfUserId,
        StartIndex: q.start,
        Limit: q.limit,
        SearchTerm: q.search,
        SortBy: 'SortName',
        Fields: ITEM_FIELDS,
      });
      return { items: res.Items.map(toArtistSummary), total: res.TotalRecordCount, start: q.start };
    });

    app.get('/artists/:id', async (req): Promise<ArtistDetail> => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      const [artist, albums] = await Promise.all([
        jellyfin.getItem(token, id, jfUserId),
        jellyfin.items(token, {
          userId: jfUserId,
          IncludeItemTypes: 'MusicAlbum',
          AlbumArtistIds: id,
          Recursive: true,
          SortBy: 'ProductionYear,PremiereDate,SortName',
          SortOrder: 'Descending',
          Fields: ITEM_FIELDS,
        }),
      ]);
      return { artist: toArtistSummary(artist), albums: albums.Items.map(toAlbumSummary) };
    });

    app.get('/albums', async (req): Promise<Paged<AlbumSummary>> => {
      const q = PageQuery.extend({ sort: z.enum(['recent', 'name', 'random', 'year']).default('name') }).parse(
        req.query,
      );
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      const sortMap = {
        recent: { SortBy: 'DateCreated', SortOrder: 'Descending' },
        name: { SortBy: 'SortName', SortOrder: 'Ascending' },
        random: { SortBy: 'Random', SortOrder: 'Ascending' },
        year: { SortBy: 'ProductionYear,SortName', SortOrder: 'Descending' },
      } as const;
      const res = await jellyfin.items(token, {
        userId: jfUserId,
        IncludeItemTypes: 'MusicAlbum',
        Recursive: true,
        StartIndex: q.start,
        Limit: q.limit,
        SearchTerm: q.search,
        Fields: ITEM_FIELDS,
        ...sortMap[q.sort],
      });
      return { items: res.Items.map(toAlbumSummary), total: res.TotalRecordCount, start: q.start };
    });

    app.get('/albums/:id', async (req): Promise<AlbumDetail> => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      const [album, tracks] = await Promise.all([
        jellyfin.getItem(token, id, jfUserId),
        jellyfin.items(token, {
          userId: jfUserId,
          ParentId: id,
          IncludeItemTypes: 'Audio',
          SortBy: 'ParentIndexNumber,IndexNumber,SortName',
          Fields: ITEM_FIELDS,
        }),
      ]);
      const albumSummary = toAlbumSummary(album);
      // Propagate the album's release-group id onto tracks that lack their own
      // ProviderIds — the right-click Refetch on a track falls back to the
      // album's request, so a poorly-tagged track still lights up the menu
      // as long as the album itself is Encore-tracked.
      const trackList = tracks.Items.map((it) => {
        const t = toTrackSummary(it);
        if (!t.mbReleaseGroupId && albumSummary.mbReleaseGroupId) {
          t.mbReleaseGroupId = albumSummary.mbReleaseGroupId;
        }
        return t;
      });
      return { album: albumSummary, tracks: trackList };
    });

    app.get('/tracks/:id', async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      const item = await jellyfin.getItem(token, id, jfUserId);
      return toTrackSummary(item);
    });

    app.get('/search', async (req): Promise<SearchResults> => {
      const { q } = z.object({ q: z.string().min(1) }).parse(req.query);
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      const common = { userId: jfUserId, Recursive: true, SearchTerm: q, Fields: ITEM_FIELDS };
      const [artists, albums, tracks] = await Promise.all([
        jellyfin.albumArtists(token, { userId: jfUserId, SearchTerm: q, Limit: 8, Fields: ITEM_FIELDS }),
        jellyfin.items(token, { ...common, IncludeItemTypes: 'MusicAlbum', Limit: 8 }),
        jellyfin.items(token, { ...common, IncludeItemTypes: 'Audio', Limit: 20 }),
      ]);
      return {
        artists: artists.Items.map(toArtistSummary),
        albums: albums.Items.map(toAlbumSummary),
        tracks: tracks.Items.map(toTrackSummary),
      };
    });
  };
}
