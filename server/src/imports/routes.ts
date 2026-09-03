import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ImportBatch } from '@encore/shared';
import type { AppDeps } from '../app.js';
import { jfContext } from '../auth/session.js';
import {
  createImportBatch,
  deleteImportBatch,
  getImportBatch,
  listImportBatches,
  requestImportItem,
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

    // Request a single missing item — creates a track request through the
    // normal Encore pipeline (visible in the Requests tab).
    app.post('/:id/items/:itemId/request', async (req): Promise<ImportBatch> => {
      const { id, itemId } = z
        .object({ id: z.string().uuid(), itemId: z.string().uuid() })
        .parse(req.params);
      const { user } = await jfContext(deps.db, req.user.sub);
      return requestImportItem(deps, user, id, itemId);
    });

    app.delete('/:id', async (req): Promise<{ ok: true }> => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { user } = await jfContext(deps.db, req.user.sub);
      await deleteImportBatch(deps, user, id);
      return { ok: true };
    });
  };
}
