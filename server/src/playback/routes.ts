import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { TrackSummary } from '@encore/shared';
import type { AppDeps } from '../app.js';
import { jfContext } from '../auth/session.js';
import { schema } from '../db/index.js';
import { ITEM_FIELDS, toTrackSummary } from '../jellyfin/mappers.js';
import { getSettings } from '../settings/service.js';
import { smartShuffle, type TrackStats } from '../shuffle/smart.js';

export function playbackRoutes(deps: AppDeps) {
  const { db, jellyfin } = deps;
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', app.authenticate);

    app.post('/events', async (req): Promise<{ ok: true }> => {
      const body = z
        .object({
          itemId: z.string().min(1),
          event: z.enum(['play', 'complete', 'skip']),
          positionSec: z.number().min(0).optional(),
          durationSec: z.number().min(0).optional(),
        })
        .parse(req.body);
      await db.insert(schema.trackPlays).values({
        userId: req.user.sub,
        itemId: body.itemId,
        event: body.event,
        positionSec: body.positionSec,
        durationSec: body.durationSec,
      });
      if (body.event === 'complete') {
        // keep Jellyfin's own play counts in sync for other clients
        const { token, jfUserId } = await jfContext(db, req.user.sub);
        await jellyfin.markPlayed(token, jfUserId, body.itemId).catch(() => {});
      }
      return { ok: true };
    });

    app.get('/favorites', async (req): Promise<TrackSummary[]> => {
      const { token, jfUserId } = await jfContext(db, req.user.sub);
      const res = await jellyfin.items(token, {
        userId: jfUserId,
        IncludeItemTypes: 'Audio',
        Filters: 'IsFavorite',
        Recursive: true,
        SortBy: 'SortName',
        Limit: 500,
        Fields: ITEM_FIELDS,
      });
      return res.Items.map(toTrackSummary);
    });

    app.post('/favorites/:itemId', async (req): Promise<{ isFavorite: boolean }> => {
      const { itemId } = z.object({ itemId: z.string() }).parse(req.params);
      const { favorite } = z.object({ favorite: z.boolean() }).parse(req.body);
      const { token, jfUserId } = await jfContext(db, req.user.sub);
      await jellyfin.setFavorite(token, jfUserId, itemId, favorite);
      return { isFavorite: favorite };
    });

    /** Reorders the given queue using play/skip/favorite/recency signals. */
    app.post('/smart-shuffle', async (req): Promise<{ order: string[] }> => {
      const { itemIds } = z.object({ itemIds: z.array(z.string()).min(1).max(2000) }).parse(req.body);
      const userId = req.user.sub;
      const [settings, rows, { token, jfUserId }] = await Promise.all([
        getSettings(db),
        db
          .select({
            itemId: schema.trackPlays.itemId,
            plays: sql<number>`count(*) filter (where ${schema.trackPlays.event} = 'complete')`.mapWith(Number),
            skips: sql<number>`count(*) filter (where ${schema.trackPlays.event} = 'skip')`.mapWith(Number),
            lastPlayedAt: sql<
              Date | null
            >`max(${schema.trackPlays.at}) filter (where ${schema.trackPlays.event} in ('play', 'complete'))`.mapWith(
              (v: string | null) => (v ? new Date(v) : null),
            ),
          })
          .from(schema.trackPlays)
          .where(and(eq(schema.trackPlays.userId, userId), inArray(schema.trackPlays.itemId, itemIds)))
          .groupBy(schema.trackPlays.itemId),
        jfContext(db, userId),
      ]);
      const stats = new Map<string, TrackStats>(rows.map((r) => [r.itemId, r]));
      const favs = await jellyfin.items(token, {
        userId: jfUserId,
        IncludeItemTypes: 'Audio',
        Filters: 'IsFavorite',
        Recursive: true,
        Limit: 1000,
      });
      const favorites = new Set(favs.Items.map((i) => i.Id));
      return { order: smartShuffle(itemIds, stats, favorites, settings.shuffle) };
    });
  };
}
