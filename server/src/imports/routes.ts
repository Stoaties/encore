import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ImportBatch } from '@encore/shared';
import type { AppDeps } from '../app.js';
import { jfContext } from '../auth/session.js';
import {
  confirmImportBatch,
  createImportBatch,
  deleteImportBatch,
  getImportBatch,
  listImportBatches,
} from './service.js';

export function importRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', app.authenticate);

    app.post('/', async (req, reply): Promise<ImportBatch> => {
      const { url } = z.object({ url: z.string().max(1000) }).parse(req.body);
      const batch = await createImportBatch(deps, req.user.sub, url);
      reply.code(201);
      return batch;
    });

    app.get('/', async (req): Promise<ImportBatch[]> => {
      return listImportBatches(deps, req.user.sub);
    });

    app.get('/:id', async (req): Promise<ImportBatch> => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { user } = await jfContext(deps.db, req.user.sub);
      return getImportBatch(deps, user, id);
    });

    app.post('/:id/confirm', async (req): Promise<ImportBatch> => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { items } = z
        .object({
          items: z
            .array(z.object({ id: z.string().uuid(), status: z.enum(['confirmed', 'rejected']) }))
            .default([]),
        })
        .parse(req.body ?? {});
      const { user } = await jfContext(deps.db, req.user.sub);
      return confirmImportBatch(deps, user, id, items);
    });

    app.delete('/:id', async (req): Promise<{ ok: true }> => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { user } = await jfContext(deps.db, req.user.sub);
      await deleteImportBatch(deps, user, id);
      return { ok: true };
    });
  };
}
