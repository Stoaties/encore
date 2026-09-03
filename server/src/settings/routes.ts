import type { FastifyInstance } from 'fastify';
import type { AppSettings } from '@encore/shared';
import type { AppDeps } from '../app.js';
import { getSettings, updateSettings, SettingsPatch } from './service.js';

export function settingsRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', app.requireAdmin);

    app.get('/', async (): Promise<AppSettings> => getSettings(deps.db));

    app.put('/', async (req): Promise<AppSettings> => {
      const patch = SettingsPatch.parse(req.body);
      return updateSettings(deps.db, patch);
    });
  };
}
