import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { jfImageUrl, type PlaylistDetail, type PlaylistShare, type PlaylistSummary } from '@encore/shared';
import type { AppDeps } from '../app.js';
import { jfContext } from '../auth/session.js';
import { schema } from '../db/index.js';
import { ITEM_FIELDS, toPlaylistSummary, toTrackSummary } from '../jellyfin/mappers.js';

// 32 URL-safe chars — 192 bits of entropy, indistinguishable from random noise
// so a leaked share URL can't be brute-forced or guessed
const newShareToken = () => randomBytes(24).toString('base64url');

async function shareForOwner(
  db: AppDeps['db'],
  ownerId: string,
  playlistId: string,
  origin?: string,
): Promise<PlaylistShare | null> {
  const row = await db.query.playlistShares.findFirst({
    where: and(eq(schema.playlistShares.ownerId, ownerId), eq(schema.playlistShares.playlistId, playlistId)),
  });
  return row ? { token: row.token, url: shareUrl(row.token, origin), createdAt: row.createdAt.toISOString() } : null;
}

const shareUrl = (token: string, origin?: string) =>
  `${(origin ?? '').replace(/\/+$/, '')}/shared/${token}`;

const originOf = (req: { headers: { host?: string; 'x-forwarded-proto'?: string | string[] } }): string => {
  const proto = ([] as string[]).concat(req.headers['x-forwarded-proto'] ?? 'https')[0];
  return req.headers.host ? `${proto}://${req.headers.host}` : '';
};

export function playlistRoutes(deps: AppDeps) {
  const { jellyfin, db } = deps;
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', app.authenticate);

    app.get('/', async (req): Promise<PlaylistSummary[]> => {
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      const res = await jellyfin.items(token, {
        userId: jfUserId,
        IncludeItemTypes: 'Playlist',
        Recursive: true,
        SortBy: 'SortName',
        Fields: ITEM_FIELDS,
      });
      return res.Items.map((i) => toPlaylistSummary(i, jfUserId));
    });

    app.post('/', async (req, reply): Promise<PlaylistSummary> => {
      const body = z
        .object({
          name: z.string().min(1).max(200),
          itemIds: z.array(z.string()).default([]),
          isPublic: z.boolean().default(false),
        })
        .parse(req.body);
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      const created = await jellyfin.createPlaylist(token, {
        Name: body.name,
        UserId: jfUserId,
        Ids: body.itemIds,
        IsPublic: body.isPublic,
      });
      reply.code(201);
      return { id: created.Id, name: body.name, trackCount: body.itemIds.length, isPublic: body.isPublic, isOwner: true };
    });

    app.get('/:id', async (req): Promise<PlaylistDetail> => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      const [playlist, items] = await Promise.all([
        jellyfin.getItem(token, id, jfUserId),
        jellyfin.playlistItems(token, id, jfUserId, { Fields: ITEM_FIELDS }),
      ]);
      const summary = toPlaylistSummary(playlist, jfUserId);
      const share = summary.isOwner ? await shareForOwner(db, req.user.sub, id, originOf(req)) : null;
      return { playlist: summary, tracks: items.Items.map(toTrackSummary), share };
    });

    app.patch('/:id', async (req, reply): Promise<PlaylistSummary> => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ isPublic: z.boolean().optional(), name: z.string().min(1).max(200).optional() }).parse(req.body);
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      // ownership check — Jellyfin will 403 non-owners, but a friendlier
      // 403 from our side avoids a mysterious 502 from the upstream mapper
      const playlist = await jellyfin.getItem(token, id, jfUserId);
      if (playlist.OwnerUserId && playlist.OwnerUserId !== jfUserId) {
        return reply.code(403).send({ error: 'Only the owner can update this playlist' });
      }
      await jellyfin.updatePlaylist(token, id, { Name: body.name, IsPublic: body.isPublic });
      const refreshed = await jellyfin.getItem(token, id, jfUserId);
      return reply.send(toPlaylistSummary(refreshed, jfUserId));
    });

    app.post('/:id/items', async (req): Promise<{ ok: true }> => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ itemIds: z.array(z.string()).min(1) }).parse(req.body);
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      await jellyfin.addPlaylistItems(token, id, body.itemIds, jfUserId);
      return { ok: true };
    });

    app.delete('/:id/items', async (req): Promise<{ ok: true }> => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { entryIds } = z.object({ entryIds: z.string().min(1) }).parse(req.query);
      const { token } = await jfContext(deps.db, req.user.sub);
      await jellyfin.removePlaylistItems(token, id, entryIds.split(','));
      return { ok: true };
    });

    app.delete('/:id', async (req): Promise<{ ok: true }> => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { token } = await jfContext(deps.db, req.user.sub);
      // dropping the playlist also drops any share tokens pointing at it
      await db.delete(schema.playlistShares).where(eq(schema.playlistShares.playlistId, id));
      await jellyfin.deleteItem(token, id);
      return { ok: true };
    });

    // ---------- share management (owner) ----------

    app.post('/:id/share', async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { token, jfUserId } = await jfContext(deps.db, req.user.sub);
      // only owners can share
      const pl = await jellyfin.getItem(token, id, jfUserId);
      if (pl.OwnerUserId && pl.OwnerUserId !== jfUserId) {
        return reply.code(403).send({ error: 'Only the owner can share this playlist' });
      }
      const existing = await shareForOwner(db, req.user.sub, id, originOf(req));
      if (existing) return reply.send(existing);
      const shareToken = newShareToken();
      const [row] = await db
        .insert(schema.playlistShares)
        .values({ playlistId: id, token: shareToken, ownerId: req.user.sub })
        .returning();
      const created: PlaylistShare = {
        token: row!.token,
        url: shareUrl(row!.token, originOf(req)),
        createdAt: row!.createdAt.toISOString(),
      };
      return reply.code(201).send(created);
    });

    app.delete('/:id/share', async (req): Promise<{ ok: true }> => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      await db
        .delete(schema.playlistShares)
        .where(
          and(eq(schema.playlistShares.ownerId, req.user.sub), eq(schema.playlistShares.playlistId, id)),
        );
      return { ok: true };
    });
  };
}

// jfImageUrl is re-exported for the public share routes elsewhere
export { jfImageUrl };
