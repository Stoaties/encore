import { desc, eq } from 'drizzle-orm';
import type { ImportBatch, ImportItem } from '@encore/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { EventBus } from '../events.js';
import type { JellyfinClient } from '../jellyfin/client.js';
import type { MusicBrainzClient } from '../musicbrainz/client.js';
import type { UserRow } from '../auth/session.js';
import { normalizeForMatch } from '@encore/shared';
import { ITEM_FIELDS } from '../jellyfin/mappers.js';
import { createRequest, trackInLibrary, RequestError } from './../requests/service.js';
import { ImportProviderError, fetchPlaylist, parsePlaylistUrl } from './providers.js';
import { matchSourceTrack } from './matching.js';
import { uploadJellyfinPrimaryImage } from './jellyfinImage.js';

export interface ImportCtx {
  db: Db;
  config: Config;
  mb: MusicBrainzClient;
  jellyfin: JellyfinClient;
  events: EventBus;
  /** provider HTTP override for tests */
  fetchImpl?: typeof fetch;
}

type BatchRow = typeof schema.importBatches.$inferSelect;
type ItemRow = typeof schema.importItems.$inferSelect;
type Jlog = (level: 'info' | 'warn' | 'error', message: string) => Promise<void>;

// ---------- serialization ----------

function toImportItem(row: ItemRow): ImportItem {
  return {
    id: row.id,
    position: row.position,
    sourceTitle: row.sourceTitle,
    sourceArtist: row.sourceArtist,
    sourceAlbum: row.sourceAlbum,
    durationMs: row.durationMs,
    matchMbRecordingId: row.matchMbRecordingId,
    matchTitle: row.matchTitle,
    matchArtist: row.matchArtist,
    matchAlbum: row.matchAlbum,
    matchScore: row.matchScore,
    matchStatus: row.matchStatus,
    inLibrary: row.inLibrary,
    requestId: row.requestId,
  };
}

function toImportBatch(row: BatchRow, items: ItemRow[]): ImportBatch {
  return {
    id: row.id,
    source: row.source,
    url: row.url,
    title: row.title,
    status: row.status,
    error: row.error,
    items: items.map(toImportItem),
    createdAt: row.createdAt.toISOString(),
    coverUrl: row.coverUrl,
    jellyfinPlaylistId: row.jellyfinPlaylistId,
    truncated: row.truncated,
  };
}

async function itemsOf(db: Db, batchId: string): Promise<ItemRow[]> {
  return db.query.importItems.findMany({
    where: eq(schema.importItems.batchId, batchId),
    orderBy: [schema.importItems.position],
  });
}

function publish(ctx: Pick<ImportCtx, 'events'>, batch: Pick<BatchRow, 'id' | 'status'>): void {
  ctx.events.publish({ kind: 'import-updated', batchId: batch.id, status: batch.status });
}

async function setBatch(ctx: ImportCtx, id: string, patch: Partial<BatchRow>): Promise<BatchRow | undefined> {
  const [row] = await ctx.db
    .update(schema.importBatches)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.importBatches.id, id))
    .returning();
  if (row) publish(ctx, row);
  return row;
}

// ---------- create / list / get / delete ----------

export async function createImportBatch(ctx: ImportCtx, userId: string, url: string): Promise<ImportBatch> {
  const parsed = parsePlaylistUrl(url);
  if (!parsed) {
    throw new ImportProviderError(400, 'Unrecognized playlist URL — paste a Spotify or YouTube playlist link');
  }
  if (parsed.source === 'youtube' && !ctx.config.youtubeApiKey) {
    throw new ImportProviderError(400, 'YouTube import is not configured (YOUTUBE_API_KEY)');
  }
  const [batch] = await ctx.db
    .insert(schema.importBatches)
    .values({ userId, source: parsed.source, url })
    .returning();
  await ctx.db.insert(schema.jobs).values({ type: 'import-resolve', payload: { batchId: batch!.id } });
  return toImportBatch(batch!, []);
}

export async function listImportBatches(ctx: ImportCtx, userId: string): Promise<ImportBatch[]> {
  const rows = await ctx.db.query.importBatches.findMany({
    where: eq(schema.importBatches.userId, userId),
    orderBy: [desc(schema.importBatches.createdAt)],
    limit: 50,
  });
  return rows.map((r) => toImportBatch(r, []));
}

async function getBatchOr404(ctx: ImportCtx, user: UserRow, id: string): Promise<BatchRow> {
  const row = await ctx.db.query.importBatches.findFirst({ where: eq(schema.importBatches.id, id) });
  if (!row) throw new RequestError(404, 'Import not found');
  if (!user.isAdmin && row.userId !== user.id) throw new RequestError(403, 'Not your import');
  return row;
}

export async function getImportBatch(ctx: ImportCtx, user: UserRow, id: string): Promise<ImportBatch> {
  const row = await getBatchOr404(ctx, user, id);
  return toImportBatch(row, await itemsOf(ctx.db, id));
}

export async function deleteImportBatch(ctx: ImportCtx, user: UserRow, id: string): Promise<void> {
  await getBatchOr404(ctx, user, id);
  // a running resolve job will find the batch gone and abort quietly
  await ctx.db.delete(schema.importBatches).where(eq(schema.importBatches.id, id));
}

// ---------- resolve (runs inside the job worker) ----------

export interface ImportJobHandler {
  resolve(batchId: string, jlog: Jlog): Promise<void>;
  fail(batchId: string, message: string): Promise<void>;
  /** Called by the acquisition worker when a request that was linked to an
   *  import item completes — the item is slotted into the Jellyfin playlist. */
  onRequestAvailable(requestId: string): Promise<void>;
}

export function importJobHandler(ctx: ImportCtx): ImportJobHandler {
  return {
    resolve: (batchId, jlog) => resolveImportBatch(ctx, batchId, jlog),
    fail: async (batchId, message) => {
      await setBatch(ctx, batchId, { status: 'failed', error: message.slice(0, 500) });
    },
    onRequestAvailable: (requestId) => onRequestAvailable(ctx, requestId),
  };
}

/**
 * Fetch the source playlist, match every track against MusicBrainz + the user's
 * Jellyfin library, then build a Jellyfin playlist from the in-library subset
 * (in original order) and upload the source cover as its primary image. Missing
 * tracks stay in the batch as inline `Request` buttons for the user to fire
 * through the normal Encore request system.
 */
export async function resolveImportBatch(ctx: ImportCtx, batchId: string, jlog: Jlog): Promise<void> {
  const batch = await ctx.db.query.importBatches.findFirst({ where: eq(schema.importBatches.id, batchId) });
  if (!batch) {
    await jlog('warn', 'Import batch was deleted — aborting');
    return;
  }
  const parsed = parsePlaylistUrl(batch.url);
  if (!parsed) throw new ImportProviderError(400, 'Unrecognized playlist URL');

  await setBatch(ctx, batchId, { status: 'resolving', error: null });
  await jlog('info', `Fetching ${batch.source} playlist…`);
  const playlist = await fetchPlaylist(ctx.config, parsed.source, parsed.id, ctx.fetchImpl ?? fetch);
  await jlog('info', `“${playlist.title}” — ${playlist.tracks.length} track(s)`);
  if (!playlist.tracks.length) {
    await setBatch(ctx, batchId, { status: 'failed', error: 'The playlist has no importable tracks' });
    return;
  }

  // retry safety: start from a clean slate
  await ctx.db.delete(schema.importItems).where(eq(schema.importItems.batchId, batchId));
  const items = await ctx.db
    .insert(schema.importItems)
    .values(
      playlist.tracks.map((t, i) => ({
        batchId,
        position: i,
        sourceTitle: t.title,
        sourceArtist: t.artist ?? null,
        sourceAlbum: t.album ?? null,
        durationMs: t.durationMs ?? null,
      })),
    )
    .returning();
  await setBatch(ctx, batchId, {
    title: playlist.title,
    coverUrl: playlist.coverUrl ?? null,
    truncated: !!playlist.truncated,
  });

  const user = await ctx.db.query.users.findFirst({ where: eq(schema.users.id, batch.userId) });
  if (!user?.jellyfinToken || !user.jellyfinUserId) {
    await setBatch(ctx, batchId, {
      status: 'failed',
      error: 'Importing user has no Jellyfin session — log in again and retry',
    });
    return;
  }

  // Match each source track against MB + look for it in the user's Jellyfin
  // library. Cache Jellyfin item ids for the tracks that ARE in-library so we
  // can seed the Jellyfin playlist in original order below.
  const inLibraryIdByItem = new Map<string, string>(); // importItem.id -> Jellyfin item id
  let matched = 0;
  let inLib = 0;
  for (const item of items) {
    const src = {
      title: item.sourceTitle,
      artist: item.sourceArtist,
      album: item.sourceAlbum,
      durationMs: item.durationMs,
    };
    try {
      const libId = src.artist
        ? await findLibraryTrackId(ctx, user.jellyfinToken, user.jellyfinUserId, src.artist, src.title)
        : null;
      if (libId) {
        inLib++;
        inLibraryIdByItem.set(item.id, libId);
        await ctx.db
          .update(schema.importItems)
          .set({ inLibrary: true })
          .where(eq(schema.importItems.id, item.id));
      } else {
        const match = await matchSourceTrack(ctx.mb, src);
        if (match.recording) matched++;
        await ctx.db
          .update(schema.importItems)
          .set({
            matchStatus: match.status,
            matchScore: match.score,
            matchMbRecordingId: match.recording?.mbid ?? null,
            matchTitle: match.recording?.title ?? null,
            matchArtist: match.recording?.artistName ?? null,
            matchMbReleaseGroupId: match.recording?.releaseGroupMbid ?? null,
            matchAlbum: match.recording?.releaseTitle ?? null,
          })
          .where(eq(schema.importItems.id, item.id));
      }
    } catch (err) {
      await jlog('warn', `“${item.sourceTitle}”: ${(err as Error).message}`);
    }
    // Keep the client view live while MB rate limiting paces us (~1 item/s).
    publish(ctx, { id: batchId, status: 'resolving' });
  }
  await jlog('info', `${inLib} already in the library; ${matched} matched via MusicBrainz`);

  // Build the Jellyfin playlist from the in-library subset in original order.
  let jfPlaylistId: string | null = null;
  const orderedInLibraryIds = items
    .map((it) => inLibraryIdByItem.get(it.id))
    .filter((v): v is string => !!v);

  if (orderedInLibraryIds.length) {
    try {
      const created = await ctx.jellyfin.createPlaylist(user.jellyfinToken, {
        Name: playlist.title,
        UserId: user.jellyfinUserId,
        // Add ids in the batch-position order — Jellyfin appends in the order given.
        Ids: orderedInLibraryIds,
        MediaType: 'Audio',
        IsPublic: false,
      });
      jfPlaylistId = created.Id;
      await jlog('info', `Created Jellyfin playlist with ${orderedInLibraryIds.length} track(s)`);
    } catch (err) {
      await jlog('warn', `Jellyfin playlist create failed: ${(err as Error).message}`);
    }
  } else {
    await jlog('info', 'No in-library tracks yet — Jellyfin playlist will be created when the first request lands');
  }

  // Upload the source cover as the playlist's primary image (best-effort).
  if (jfPlaylistId && playlist.coverUrl) {
    try {
      await uploadJellyfinPrimaryImage(
        ctx.config.jellyfinUrl,
        user.jellyfinToken,
        jfPlaylistId,
        playlist.coverUrl,
        ctx.fetchImpl ?? fetch,
      );
      await jlog('info', 'Uploaded playlist cover art');
    } catch (err) {
      await jlog('warn', `Cover upload failed: ${(err as Error).message}`);
    }
  }

  await setBatch(ctx, batchId, {
    status: 'done',
    jellyfinPlaylistId: jfPlaylistId,
    error: playlist.truncated
      ? 'Only the first 100 tracks were fetched (Spotify’s public embed limits it)'
      : null,
  });
}

/**
 * Jellyfin item id for a track already in the user's library (artist + title
 * fuzzy match, same rules as the acquisition worker's trackInLibrary check).
 * Returns null if it's not there — the caller keeps the item as "missing".
 */
async function findLibraryTrackId(
  ctx: Pick<ImportCtx, 'jellyfin'>,
  jfToken: string,
  jfUserId: string,
  artistName: string,
  trackTitle: string,
): Promise<string | null> {
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
  for (const item of res.Items) {
    if (normalizeForMatch(item.Name ?? '') !== wantTitle) continue;
    const artists = [item.AlbumArtist, ...(item.Artists ?? [])].filter((a): a is string => !!a);
    if (artists.some((a) => normalizeForMatch(a) === wantArtist)) return item.Id;
  }
  return null;
}

// ---------- request one missing item (fires the normal Encore request pipeline) ----------

/**
 * Turn a single "missing" import item into a track request. Reuses the standard
 * `createRequest` so the resulting row appears in the Requests tab like any
 * other; the SSE handler below will re-slot the track into the Jellyfin
 * playlist at its original position once acquisition completes.
 */
export async function requestImportItem(
  ctx: ImportCtx,
  user: UserRow,
  batchId: string,
  itemId: string,
): Promise<ImportBatch> {
  const batch = await getBatchOr404(ctx, user, batchId);
  const item = await ctx.db.query.importItems.findFirst({
    where: eq(schema.importItems.id, itemId),
  });
  if (!item || item.batchId !== batchId) throw new RequestError(404, 'Item not found');
  if (item.inLibrary) throw new RequestError(409, 'Already in the library');
  if (!item.matchMbRecordingId) throw new RequestError(409, 'No MusicBrainz match — nothing to request');

  try {
    const req = await createRequest(ctx, user, { type: 'track', mbid: item.matchMbRecordingId });
    await ctx.db
      .update(schema.importItems)
      .set({ matchStatus: 'confirmed', requestId: req.id })
      .where(eq(schema.importItems.id, item.id));
  } catch (err) {
    // 409 "already requested / available" — link the existing request row if we can find it
    if (err instanceof RequestError && err.statusCode === 409) {
      const existing = await ctx.db.query.requests.findFirst({
        where: eq(schema.requests.mbRecordingId, item.matchMbRecordingId),
      });
      if (existing) {
        await ctx.db
          .update(schema.importItems)
          .set({ matchStatus: 'confirmed', requestId: existing.id })
          .where(eq(schema.importItems.id, item.id));
      }
    } else {
      throw err;
    }
  }

  publish(ctx, batch);
  return toImportBatch(batch, await itemsOf(ctx.db, batchId));
}

// ---------- SSE hook: slot a newly-available track into its playlist ----------

/**
 * When a track request tied to an import becomes `available`, add the freshly
 * scanned Jellyfin item into the batch's Jellyfin playlist at its original
 * position. Called from the request pipeline's post-completion hook (or from
 * the SSE bridge in app.ts).
 */
export async function onRequestAvailable(ctx: ImportCtx, requestId: string): Promise<void> {
  const items = await ctx.db.query.importItems.findMany({
    where: eq(schema.importItems.requestId, requestId),
  });
  if (!items.length) return;

  for (const item of items) {
    const batch = await ctx.db.query.importBatches.findFirst({
      where: eq(schema.importBatches.id, item.batchId),
    });
    if (!batch) continue;
    const user = await ctx.db.query.users.findFirst({ where: eq(schema.users.id, batch.userId) });
    if (!user?.jellyfinToken || !user.jellyfinUserId) continue;

    // Find the Jellyfin item that now backs this request
    const req = await ctx.db.query.requests.findFirst({ where: eq(schema.requests.id, requestId) });
    if (!req?.mbRecordingId) continue;
    const jfItemId = await findLibraryTrackId(
      ctx,
      user.jellyfinToken,
      user.jellyfinUserId,
      req.artistName ?? '',
      req.trackTitle ?? '',
    );
    if (!jfItemId) continue;

    // Create the playlist lazily if this is the first landing track
    let playlistId = batch.jellyfinPlaylistId;
    if (!playlistId) {
      try {
        const created = await ctx.jellyfin.createPlaylist(user.jellyfinToken, {
          Name: batch.title ?? 'Imported playlist',
          UserId: user.jellyfinUserId,
          Ids: [jfItemId],
          MediaType: 'Audio',
          IsPublic: false,
        });
        playlistId = created.Id;
        await ctx.db
          .update(schema.importBatches)
          .set({ jellyfinPlaylistId: playlistId, updatedAt: new Date() })
          .where(eq(schema.importBatches.id, batch.id));
        if (batch.coverUrl) {
          try {
            await uploadJellyfinPrimaryImage(
              ctx.config.jellyfinUrl,
              user.jellyfinToken,
              playlistId,
              batch.coverUrl,
              ctx.fetchImpl ?? fetch,
            );
          } catch {
            // best-effort
          }
        }
      } catch {
        continue;
      }
    } else {
      try {
        await ctx.jellyfin.addPlaylistItems(user.jellyfinToken, playlistId, [jfItemId], user.jellyfinUserId);
      } catch {
        continue;
      }
    }

    await ctx.db
      .update(schema.importItems)
      .set({ inLibrary: true })
      .where(eq(schema.importItems.id, item.id));
    publish(ctx, batch);
  }
}
