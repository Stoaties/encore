import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, eq, inArray } from 'drizzle-orm';
import type { JobLogLine, MusicRequest } from '@encore/shared';
import type { AppDeps } from '../app.js';
import { schema } from '../db/index.js';
import { getUserRow } from '../auth/session.js';
import {
  createRequest,
  approveRequest,
  denyRequest,
  retryRequest,
  refetchRequest,
  deleteRequest,
  listRequests,
  RequestError,
  type RequestCtx,
} from './service.js';

const CreateBody = z.object({
  type: z.enum(['track', 'album', 'artist']),
  mbid: z.string().uuid(),
});
const IdParam = z.object({ id: z.string().uuid() });

export function requestRoutes(deps: AppDeps) {
  const ctx: RequestCtx = {
    db: deps.db,
    mb: deps.mb,
    jellyfin: deps.jellyfin,
    events: deps.events,
    config: deps.config,
  };

  return async (app: FastifyInstance) => {
    const requireUser = async (userId: string) => {
      const user = await getUserRow(deps.db, userId);
      if (!user) throw new RequestError(401, 'Unknown user');
      return user;
    };

    app.post('/', { preHandler: app.authenticate }, async (req, reply): Promise<MusicRequest> => {
      const body = CreateBody.parse(req.body);
      const user = await requireUser(req.user.sub);
      const result = await createRequest(ctx, user, body);
      reply.code(201);
      return result;
    });

    app.get('/', { preHandler: app.authenticate }, async (req): Promise<MusicRequest[]> => {
      const q = z
        .object({
          scope: z.enum(['mine', 'all']).default('all'),
          status: z
            .enum(['pending', 'approved', 'denied', 'searching', 'downloading', 'processing', 'available', 'failed'])
            .optional(),
        })
        .parse(req.query);
      return listRequests(ctx, {
        forUserId: q.scope === 'mine' ? req.user.sub : undefined,
        status: q.status,
      });
    });

    app.post('/:id/approve', { preHandler: app.requireAdmin }, async (req): Promise<MusicRequest> => {
      const { id } = IdParam.parse(req.params);
      return approveRequest(ctx, await requireUser(req.user.sub), id);
    });

    app.post('/:id/deny', { preHandler: app.requireAdmin }, async (req): Promise<MusicRequest> => {
      const { id } = IdParam.parse(req.params);
      return denyRequest(ctx, id);
    });

    app.post('/:id/retry', { preHandler: app.authenticate }, async (req): Promise<MusicRequest> => {
      const { id } = IdParam.parse(req.params);
      return retryRequest(ctx, await requireUser(req.user.sub), id);
    });

    app.post('/:id/refetch', { preHandler: app.authenticate }, async (req): Promise<MusicRequest> => {
      const { id } = IdParam.parse(req.params);
      return refetchRequest(ctx, await requireUser(req.user.sub), id);
    });

    app.delete('/:id', { preHandler: app.authenticate }, async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      await deleteRequest(ctx, await requireUser(req.user.sub), id);
      reply.code(204);
    });

    // acquisition job logs for a request (children included for artist requests)
    app.get('/:id/logs', { preHandler: app.requireAdmin }, async (req): Promise<JobLogLine[]> => {
      const { id } = IdParam.parse(req.params);
      const children = await deps.db.query.requests.findMany({
        where: eq(schema.requests.parentId, id),
        columns: { id: true },
      });
      const jobRows = await deps.db.query.jobs.findMany({
        where: inArray(schema.jobs.requestId, [id, ...children.map((c) => c.id)]),
        columns: { id: true },
      });
      if (!jobRows.length) return [];
      const logs = await deps.db.query.jobLogs.findMany({
        where: inArray(
          schema.jobLogs.jobId,
          jobRows.map((j) => j.id),
        ),
        orderBy: [asc(schema.jobLogs.id)],
        limit: 1000,
      });
      return logs.map((l) => ({ ts: l.ts.toISOString(), level: l.level, message: l.message }));
    });
  };
}

/** Server-sent events stream: request updates + job logs. */
export function eventRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    app.get('/', { preHandler: app.authenticate }, (req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': (req.headers.origin as string) ?? '*',
        'Access-Control-Allow-Credentials': 'true',
      });
      reply.raw.write(': connected\n\n');
      const unsubscribe = deps.events.subscribe((event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => reply.raw.write(': hb\n\n'), 25_000);
      req.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    });
  };
}
