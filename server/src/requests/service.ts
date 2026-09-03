import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  normalizeForMatch,
  type CreateRequestBody,
  type MusicRequest,
  type RequestStatus,
} from '@encore/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { JellyfinClient } from '../jellyfin/client.js';
import type { MusicBrainzClient } from '../musicbrainz/client.js';
import type { EventBus } from '../events.js';
import type { UserRow } from '../auth/session.js';
import { NoJellyfinSessionError } from '../auth/session.js';
import { getSettings } from '../settings/service.js';
import { ITEM_FIELDS } from '../jellyfin/mappers.js';
import type { BlocklistedSource } from '../acquisition/worker.js';

export class RequestError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export interface RequestCtx {
  db: Db;
  mb: MusicBrainzClient;
  jellyfin: JellyfinClient;
  events: EventBus;
  config: Config;
}

type RequestRow = typeof schema.requests.$inferSelect;

/** Statuses that make a new request for the same MB entity a duplicate. */
export const OPEN_STATUSES: RequestStatus[] = ['pending', 'approved', 'searching', 'downloading', 'processing'];

// ---------- serialization ----------

function toMusicRequest(row: RequestRow, username: string, children?: MusicRequest[]): MusicRequest {
  const meta = (row.meta ?? {}) as { coverUrl?: string; year?: number };
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    artistName: row.artistName,
    albumTitle: row.albumTitle,
    trackTitle: row.trackTitle,
    mbArtistId: row.mbArtistId,
    mbReleaseGroupId: row.mbReleaseGroupId,
    mbRecordingId: row.mbRecordingId,
    coverUrl: meta.coverUrl ?? null,
    year: meta.year ?? null,
    requestedBy: { id: row.requestedBy, username },
    parentId: row.parentId,
    errorMessage: row.errorMessage,
    progress: row.progress,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(children ? { children } : {}),
  };
}

async function usernamesFor(db: Db, userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const rows = await db.query.users.findMany({ where: inArray(schema.users.id, [...new Set(userIds)]) });
  return new Map(rows.map((u) => [u.id, u.username]));
}

async function serializeWithChildren(db: Db, row: RequestRow): Promise<MusicRequest> {
  const children = await db.query.requests.findMany({
    where: eq(schema.requests.parentId, row.id),
    orderBy: [schema.requests.createdAt],
  });
  const names = await usernamesFor(db, [row.requestedBy, ...children.map((c) => c.requestedBy)]);
  const name = (id: string) => names.get(id) ?? 'unknown';
  return toMusicRequest(
    row,
    name(row.requestedBy),
    children.map((c) => toMusicRequest(c, name(c.requestedBy))),
  );
}

export async function publishUpdated(ctx: Pick<RequestCtx, 'db' | 'events'>, id: string): Promise<MusicRequest> {
  const row = await ctx.db.query.requests.findFirst({ where: eq(schema.requests.id, id) });
  if (!row) throw new RequestError(404, 'Request not found');
  const serialized = await serializeWithChildren(ctx.db, row);
  ctx.events.publish({ kind: 'request-updated', request: serialized });
  return serialized;
}

// ---------- library / duplicate checks ----------

async function findOpenRequest(
  db: Db,
  col: 'mbArtistId' | 'mbReleaseGroupId' | 'mbRecordingId',
  mbid: string,
): Promise<RequestRow | undefined> {
  const column = schema.requests[col];
  const rows = await db.query.requests.findMany({
    where: and(eq(column, mbid), inArray(schema.requests.status, [...OPEN_STATUSES, 'available'])),
    limit: 1,
  });
  return rows[0];
}

async function albumInLibrary(
  ctx: RequestCtx,
  jfToken: string,
  jfUserId: string,
  artistName: string,
  albumTitle: string,
  rgMbid?: string | null,
): Promise<boolean> {
  const res = await ctx.jellyfin.items(jfToken, {
    userId: jfUserId,
    IncludeItemTypes: 'MusicAlbum',
    Recursive: true,
    SearchTerm: albumTitle,
    Limit: 30,
    Fields: ITEM_FIELDS,
  });
  const wantTitle = normalizeForMatch(albumTitle);
  const wantArtist = normalizeForMatch(artistName);
  return res.Items.some((item) => {
    if (rgMbid && item.ProviderIds?.MusicBrainzReleaseGroup === rgMbid) return true;
    const artist = item.AlbumArtist ?? item.Artists?.[0] ?? '';
    return normalizeForMatch(item.Name ?? '') === wantTitle && normalizeForMatch(artist) === wantArtist;
  });
}

export async function trackInLibrary(
  ctx: Pick<RequestCtx, 'jellyfin'>,
  jfToken: string,
  jfUserId: string,
  artistName: string,
  trackTitle: string,
): Promise<boolean> {
  const res = await ctx.jellyfin.items(jfToken, {
    userId: jfUserId,
    IncludeItemTypes: 'Audio',
    Recursive: true,
    SearchTerm: trackTitle,
    Limit: 50,
    Fields: ITEM_FIELDS,
  });
  const wantTitle = normalizeForMatch(trackTitle);
  const wantArtist = normalizeForMatch(artistName);
  return res.Items.some((item) => {
    if (normalizeForMatch(item.Name ?? '') !== wantTitle) return false;
    const artists = [item.AlbumArtist, ...(item.Artists ?? [])].filter((a): a is string => !!a);
    return artists.some((a) => normalizeForMatch(a) === wantArtist);
  });
}

// ---------- jobs ----------

async function enqueueAcquire(db: Db, requestIds: string[]): Promise<void> {
  if (!requestIds.length) return;
  await db.insert(schema.jobs).values(requestIds.map((id) => ({ type: 'acquire-request', requestId: id, payload: {} })));
}

// ---------- create ----------

export async function createRequest(ctx: RequestCtx, user: UserRow, body: CreateRequestBody): Promise<MusicRequest> {
  if (!user.jellyfinToken) throw new NoJellyfinSessionError();
  const settings = await getSettings(ctx.db);

  if (!user.isAdmin && settings.quotaPerUserPerDay > 0) {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [row] = await ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.requestedBy, user.id),
          isNull(schema.requests.parentId),
          gt(schema.requests.createdAt, since),
        ),
      );
    if ((row?.count ?? 0) >= settings.quotaPerUserPerDay) {
      throw new RequestError(429, `Daily request quota reached (${settings.quotaPerUserPerDay}/day)`);
    }
  }

  const autoApprove = user.isAdmin ? settings.autoApprove.admins : settings.autoApprove.users;
  const status: RequestStatus = autoApprove ? 'approved' : 'pending';
  const approval = autoApprove ? { approvedBy: user.id, approvedAt: new Date() } : {};

  if (body.type === 'track') {
    const dup = await findOpenRequest(ctx.db, 'mbRecordingId', body.mbid);
    if (dup) throw new RequestError(409, dup.status === 'available' ? 'Already available' : 'Already requested');
    const rec = await ctx.mb.lookupRecording(body.mbid);
    if (await trackInLibrary(ctx, user.jellyfinToken, user.jellyfinUserId, rec.artistName, rec.title)) {
      throw new RequestError(409, 'Already in the library');
    }
    const [row] = await ctx.db
      .insert(schema.requests)
      .values({
        type: 'track',
        status,
        requestedBy: user.id,
        artistName: rec.artistName,
        trackTitle: rec.title,
        albumTitle: rec.releaseTitle,
        mbRecordingId: rec.mbid,
        mbReleaseGroupId: rec.releaseGroupMbid,
        mbArtistId: rec.artistMbid,
        meta: { coverUrl: rec.coverUrl, durationMs: rec.durationMs },
        ...approval,
      })
      .returning();
    if (status === 'approved') await enqueueAcquire(ctx.db, [row!.id]);
    return publishUpdated(ctx, row!.id);
  }

  if (body.type === 'album') {
    const dup = await findOpenRequest(ctx.db, 'mbReleaseGroupId', body.mbid);
    if (dup) throw new RequestError(409, dup.status === 'available' ? 'Already available' : 'Already requested');
    const rg = await ctx.mb.lookupReleaseGroup(body.mbid);
    if (await albumInLibrary(ctx, user.jellyfinToken, user.jellyfinUserId, rg.artistName, rg.title, rg.mbid)) {
      throw new RequestError(409, 'Already in the library');
    }
    const [row] = await ctx.db
      .insert(schema.requests)
      .values({
        type: 'album',
        status,
        requestedBy: user.id,
        artistName: rg.artistName,
        albumTitle: rg.title,
        mbReleaseGroupId: rg.mbid,
        mbArtistId: rg.artistMbid,
        meta: { coverUrl: rg.coverUrl, year: rg.year },
        ...approval,
      })
      .returning();
    if (status === 'approved') await enqueueAcquire(ctx.db, [row!.id]);
    return publishUpdated(ctx, row!.id);
  }

  // artist discography: parent + one child album request per missing release group
  const dup = await findOpenRequest(ctx.db, 'mbArtistId', body.mbid);
  if (dup && dup.type === 'artist') throw new RequestError(409, 'Artist discography already requested');
  const artist = await ctx.mb.lookupArtist(body.mbid);
  const discography = (await ctx.mb.artistReleaseGroups(body.mbid)).filter(
    (rg) => (rg.primaryType === 'Album' || rg.primaryType === 'EP') && rg.secondaryTypes.length === 0,
  );
  if (!discography.length) throw new RequestError(422, 'No studio albums or EPs found for this artist');

  const missing: typeof discography = [];
  for (const rg of discography) {
    if (await findOpenRequest(ctx.db, 'mbReleaseGroupId', rg.mbid)) continue;
    if (await albumInLibrary(ctx, user.jellyfinToken, user.jellyfinUserId, rg.artistName, rg.title, rg.mbid)) continue;
    missing.push(rg);
  }
  if (!missing.length) throw new RequestError(409, 'Entire discography is already in the library or requested');

  const [parent] = await ctx.db
    .insert(schema.requests)
    .values({
      type: 'artist',
      status,
      requestedBy: user.id,
      artistName: artist.name,
      mbArtistId: artist.mbid,
      meta: { totalAlbums: missing.length },
      ...approval,
    })
    .returning();
  const children = await ctx.db
    .insert(schema.requests)
    .values(
      missing.map((rg) => ({
        type: 'album' as const,
        status,
        requestedBy: user.id,
        parentId: parent!.id,
        artistName: rg.artistName,
        albumTitle: rg.title,
        mbReleaseGroupId: rg.mbid,
        mbArtistId: rg.artistMbid ?? artist.mbid,
        meta: { coverUrl: rg.coverUrl, year: rg.year },
        ...approval,
      })),
    )
    .returning();
  if (status === 'approved') await enqueueAcquire(ctx.db, children.map((c) => c.id));
  return publishUpdated(ctx, parent!.id);
}

// ---------- moderation / lifecycle ----------

async function getRequestOr404(db: Db, id: string): Promise<RequestRow> {
  const row = await db.query.requests.findFirst({ where: eq(schema.requests.id, id) });
  if (!row) throw new RequestError(404, 'Request not found');
  return row;
}

export async function approveRequest(ctx: RequestCtx, admin: UserRow, id: string): Promise<MusicRequest> {
  const row = await getRequestOr404(ctx.db, id);
  if (row.status !== 'pending') throw new RequestError(409, `Cannot approve a ${row.status} request`);
  const patch = { status: 'approved' as const, approvedBy: admin.id, approvedAt: new Date(), updatedAt: new Date() };
  await ctx.db.update(schema.requests).set(patch).where(eq(schema.requests.id, id));
  const children = await ctx.db
    .update(schema.requests)
    .set(patch)
    .where(and(eq(schema.requests.parentId, id), eq(schema.requests.status, 'pending')))
    .returning();
  await enqueueAcquire(ctx.db, row.type === 'artist' ? children.map((c) => c.id) : [id]);
  return publishUpdated(ctx, id);
}

export async function denyRequest(ctx: RequestCtx, id: string): Promise<MusicRequest> {
  const row = await getRequestOr404(ctx.db, id);
  if (row.status !== 'pending') throw new RequestError(409, `Cannot deny a ${row.status} request`);
  const patch = { status: 'denied' as const, updatedAt: new Date() };
  await ctx.db.update(schema.requests).set(patch).where(eq(schema.requests.id, id));
  await ctx.db
    .update(schema.requests)
    .set(patch)
    .where(and(eq(schema.requests.parentId, id), eq(schema.requests.status, 'pending')));
  return publishUpdated(ctx, id);
}

export async function retryRequest(ctx: RequestCtx, user: UserRow, id: string): Promise<MusicRequest> {
  const row = await getRequestOr404(ctx.db, id);
  if (!user.isAdmin && row.requestedBy !== user.id) throw new RequestError(403, 'Not your request');
  const retryPatch = {
    status: 'approved' as const,
    errorMessage: null,
    progress: null,
    updatedAt: new Date(),
  };
  if (row.type === 'artist') {
    const failed = await ctx.db
      .update(schema.requests)
      .set(retryPatch)
      .where(and(eq(schema.requests.parentId, id), eq(schema.requests.status, 'failed')))
      .returning();
    if (!failed.length) throw new RequestError(409, 'No failed albums to retry');
    await ctx.db
      .update(schema.requests)
      .set({ status: 'approved', errorMessage: null, updatedAt: new Date() })
      .where(and(eq(schema.requests.id, id), eq(schema.requests.status, 'failed')));
    await enqueueAcquire(ctx.db, failed.map((c) => c.id));
  } else {
    if (row.status !== 'failed') throw new RequestError(409, `Cannot retry a ${row.status} request`);
    await ctx.db.update(schema.requests).set(retryPatch).where(eq(schema.requests.id, id));
    await enqueueAcquire(ctx.db, [id]);
  }
  return publishUpdated(ctx, id);
}

/**
 * "Grabbed the wrong version" recovery: deletes the files that were imported for
 * this request, blocklists the slskd source that provided them, and re-queues
 * acquisition. Only for finished (available) track/album requests — artist
 * parents refetch per-child.
 */
export async function refetchRequest(ctx: RequestCtx, user: UserRow, id: string): Promise<MusicRequest> {
  const row = await getRequestOr404(ctx.db, id);
  if (!user.isAdmin && row.requestedBy !== user.id) throw new RequestError(403, 'Not your request');
  if (row.type === 'artist') throw new RequestError(409, 'Refetch albums individually, not the whole discography');
  if (row.status !== 'available') throw new RequestError(409, `Cannot refetch a ${row.status} request`);
  if (!ctx.config.jellyfinApiKey) throw new RequestError(500, 'JELLYFIN_API_KEY not configured');
  const token = ctx.config.jellyfinApiKey;

  const meta = (row.meta ?? {}) as { lastSource?: BlocklistedSource; blocklistedSources?: BlocklistedSource[]; [k: string]: unknown };
  const lastSource = meta.lastSource;
  const blocklist = meta.blocklistedSources ?? [];

  // find + delete the file(s) this request added to Jellyfin
  const itemType = row.type === 'album' ? 'MusicAlbum' : 'Audio';
  const search = row.type === 'album' ? (row.albumTitle ?? '') : (row.trackTitle ?? '');
  const found = await ctx.jellyfin.items(token, {
    IncludeItemTypes: itemType,
    Recursive: true,
    SearchTerm: search,
    Limit: 50,
    Fields: 'ProviderIds,Path',
  });
  const wantTitle = normalizeForMatch(search);
  const wantArtist = normalizeForMatch(row.artistName);
  const mbid = row.type === 'album' ? row.mbReleaseGroupId : row.mbRecordingId;
  const matches = found.Items.filter((item) => {
    if (mbid) {
      const provider = row.type === 'album' ? item.ProviderIds?.MusicBrainzReleaseGroup : item.ProviderIds?.MusicBrainzTrack;
      if (provider === mbid) return true;
    }
    if (normalizeForMatch(item.Name ?? '') !== wantTitle) return false;
    const artists = [item.AlbumArtist, ...(item.Artists ?? [])].filter((a): a is string => !!a);
    return artists.some((a) => normalizeForMatch(a) === wantArtist);
  });
  for (const item of matches) {
    // best-effort: if a delete fails we still re-queue acquisition
    await ctx.jellyfin.deleteItem(token, item.Id).catch(() => {});
  }

  const newBlocklist = lastSource ? [...blocklist, lastSource] : blocklist;
  const newMeta = { ...meta, blocklistedSources: newBlocklist };
  delete (newMeta as Record<string, unknown>).lastSource;

  await ctx.db
    .update(schema.requests)
    .set({
      status: 'approved',
      progress: null,
      errorMessage: null,
      availableAt: null,
      meta: newMeta,
      updatedAt: new Date(),
    })
    .where(eq(schema.requests.id, id));
  await enqueueAcquire(ctx.db, [id]);
  // rescan so Jellyfin drops the just-deleted rows before the next scan finds the new files
  await ctx.jellyfin.refreshLibrary(token).catch(() => {});
  return publishUpdated(ctx, id);
}

export async function deleteRequest(ctx: RequestCtx, user: UserRow, id: string): Promise<void> {
  const row = await getRequestOr404(ctx.db, id);
  if (!user.isAdmin) {
    if (row.requestedBy !== user.id) throw new RequestError(403, 'Not your request');
    const deletable: RequestStatus[] = ['pending', 'denied', 'failed'];
    if (!deletable.includes(row.status)) {
      throw new RequestError(409, 'Only pending, denied or failed requests can be deleted');
    }
  }
  const children = await ctx.db.query.requests.findMany({ where: eq(schema.requests.parentId, id) });
  const ids = [id, ...children.map((c) => c.id)];
  await ctx.db
    .delete(schema.jobs)
    .where(and(inArray(schema.jobs.requestId, ids), eq(schema.jobs.status, 'pending')));
  await ctx.db.delete(schema.requests).where(inArray(schema.requests.id, ids));
}

// ---------- listing ----------

export async function listRequests(
  ctx: RequestCtx,
  opts: { forUserId?: string; status?: RequestStatus },
): Promise<MusicRequest[]> {
  const where = and(
    isNull(schema.requests.parentId),
    opts.forUserId ? eq(schema.requests.requestedBy, opts.forUserId) : undefined,
    opts.status ? eq(schema.requests.status, opts.status) : undefined,
  );
  const top = await ctx.db.query.requests.findMany({
    where,
    orderBy: [desc(schema.requests.createdAt)],
    limit: 200,
  });
  if (!top.length) return [];
  const children = await ctx.db.query.requests.findMany({
    where: inArray(
      schema.requests.parentId,
      top.map((r) => r.id),
    ),
    orderBy: [schema.requests.createdAt],
  });
  const names = await usernamesFor(ctx.db, [...top, ...children].map((r) => r.requestedBy));
  const name = (uid: string) => names.get(uid) ?? 'unknown';
  const byParent = new Map<string, MusicRequest[]>();
  for (const c of children) {
    const list = byParent.get(c.parentId!) ?? [];
    list.push(toMusicRequest(c, name(c.requestedBy)));
    byParent.set(c.parentId!, list);
  }
  return top.map((r) =>
    toMusicRequest(r, name(r.requestedBy), r.type === 'artist' ? (byParent.get(r.id) ?? []) : undefined),
  );
}

/** MBIDs referenced by open requests — used to badge MB search results. */
export async function openRequestMbids(db: Db): Promise<{
  artists: Set<string>;
  releaseGroups: Set<string>;
  recordings: Set<string>;
}> {
  const rows = await db.query.requests.findMany({
    where: inArray(schema.requests.status, OPEN_STATUSES),
    columns: { mbArtistId: true, mbReleaseGroupId: true, mbRecordingId: true, type: true },
  });
  const artists = new Set<string>();
  const releaseGroups = new Set<string>();
  const recordings = new Set<string>();
  for (const r of rows) {
    if (r.type === 'artist' && r.mbArtistId) artists.add(r.mbArtistId);
    if (r.mbReleaseGroupId) releaseGroups.add(r.mbReleaseGroupId);
    if (r.mbRecordingId) recordings.add(r.mbRecordingId);
  }
  return { artists, releaseGroups, recordings };
}
