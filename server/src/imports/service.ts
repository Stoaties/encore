import { desc, eq } from 'drizzle-orm';
import type { ImportBatch, ImportItem } from '@encore/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { EventBus } from '../events.js';
import type { JellyfinClient } from '../jellyfin/client.js';
import type { MusicBrainzClient } from '../musicbrainz/client.js';
import type { UserRow } from '../auth/session.js';
import { createRequest, trackInLibrary, RequestError } from './../requests/service.js';
import { ImportProviderError, fetchPlaylist, parsePlaylistUrl } from './providers.js';
import { matchSourceTrack } from './matching.js';

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
  // fail fast on missing provider credentials instead of creating a doomed batch.
  // (Spotify goes through spotdl-web so needs no credentials in this process.)
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
}

export function importJobHandler(ctx: ImportCtx): ImportJobHandler {
  return {
    resolve: (batchId, jlog) => resolveImportBatch(ctx, batchId, jlog),
    fail: async (batchId, message) => {
      await setBatch(ctx, batchId, { status: 'failed', error: message.slice(0, 500) });
    },
  };
}

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
  await setBatch(ctx, batchId, { title: playlist.title });

  // library checks use the importing user's Jellyfin view; createRequest re-checks
  // with canonical MB names at confirm time, so this is only a UI hint
  const user = await ctx.db.query.users.findFirst({ where: eq(schema.users.id, batch.userId) });
  const jf = user?.jellyfinToken && user.jellyfinUserId ? { token: user.jellyfinToken, userId: user.jellyfinUserId } : null;

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
      if (jf && src.artist && (await trackInLibrary(ctx, jf.token, jf.userId, src.artist, src.title))) {
        inLib++;
        await ctx.db.update(schema.importItems).set({ inLibrary: true }).where(eq(schema.importItems.id, item.id));
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
    // keep the review screen live while MB rate limiting paces us (~1 item/s)
    publish(ctx, { id: batchId, status: 'resolving' });
  }
  await jlog('info', `Matched ${matched} track(s); ${inLib} already in the library`);
  await setBatch(ctx, batchId, { status: 'review' });
}

// ---------- confirm ----------

export interface ConfirmDecision {
  id: string;
  status: 'confirmed' | 'rejected';
}

/**
 * Turns reviewed matches into track requests. 'auto' matches are requested
 * unless rejected; 'needs_review' only when explicitly confirmed. A 409 from
 * createRequest means the track is already covered — that counts as success.
 */
export async function confirmImportBatch(
  ctx: ImportCtx,
  user: UserRow,
  batchId: string,
  decisions: ConfirmDecision[],
): Promise<ImportBatch> {
  const batch = await getBatchOr404(ctx, user, batchId);
  if (batch.status !== 'review') throw new RequestError(409, `Cannot confirm a ${batch.status} import`);
  const items = await itemsOf(ctx.db, batchId);
  const byId = new Map(items.map((i) => [i.id, i]));
  const decision = new Map<string, ConfirmDecision['status']>();
  for (const d of decisions) {
    if (byId.has(d.id)) decision.set(d.id, d.status);
  }

  await setBatch(ctx, batchId, { status: 'requesting' });
  let batchError: string | null = null;
  for (const item of items) {
    if (!item.matchMbRecordingId || item.inLibrary) continue;
    const wanted = decision.get(item.id) ?? (item.matchStatus === 'auto' ? 'confirmed' : null);
    if (wanted === 'rejected') {
      await ctx.db.update(schema.importItems).set({ matchStatus: 'rejected' }).where(eq(schema.importItems.id, item.id));
      continue;
    }
    if (wanted !== 'confirmed') continue;
    let requestId: string | null = null;
    try {
      const req = await createRequest(ctx, user, { type: 'track', mbid: item.matchMbRecordingId });
      requestId = req.id;
    } catch (err) {
      if (err instanceof RequestError && err.statusCode === 409) {
        // already requested / available / in the library — nothing to do
      } else if (err instanceof RequestError && err.statusCode === 429) {
        batchError = 'Daily request quota reached — the remaining tracks were not requested';
        break;
      } else {
        batchError ??= `“${item.sourceTitle}”: ${(err as Error).message}`;
        continue;
      }
    }
    await ctx.db
      .update(schema.importItems)
      .set({ matchStatus: 'confirmed', requestId })
      .where(eq(schema.importItems.id, item.id));
  }
  const row = await setBatch(ctx, batchId, { status: 'done', error: batchError });
  return toImportBatch(row!, await itemsOf(ctx.db, batchId));
}
