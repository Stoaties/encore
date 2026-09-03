import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { JellyfinClient, JellyfinError } from './jellyfin/client.js';
import { MusicBrainzClient, MusicBrainzError } from './musicbrainz/client.js';
import { EventBus } from './events.js';
import { NoJellyfinSessionError } from './auth/session.js';
import { RequestError } from './requests/service.js';
import { authRoutes } from './auth/routes.js';
import { libraryRoutes } from './library/routes.js';
import { mbRoutes } from './musicbrainz/routes.js';
import { requestRoutes, eventRoutes } from './requests/routes.js';
import { settingsRoutes } from './settings/routes.js';
import { playlistRoutes } from './playlists/routes.js';
import { publicPlaylistRoutes } from './playlists/publicRoutes.js';
import { playbackRoutes } from './playback/routes.js';
import { importRoutes } from './imports/routes.js';
import { ImportProviderError } from './imports/providers.js';

export interface AppDeps {
  config: Config;
  db: Db;
  jellyfin: JellyfinClient;
  mb: MusicBrainzClient;
  events: EventBus;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: process.env.VITEST ? false : { level: deps.config.isProd ? 'info' : 'debug' },
    trustProxy: true,
  });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: deps.config.jwtSecret });

  app.decorate('authenticate', async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });
  app.decorate('requireAdmin', async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (!req.user.isAdmin) {
      reply.code(403).send({ error: 'Admin access required' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', details: err.issues });
    }
    if (err instanceof NoJellyfinSessionError) {
      return reply.code(401).send({ error: err.message });
    }
    if (err instanceof RequestError || err instanceof ImportProviderError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if (err instanceof MusicBrainzError) {
      req.log.error({ err }, 'musicbrainz upstream error');
      return reply.code(502).send({ error: 'MusicBrainz is unavailable, try again shortly' });
    }
    if (err instanceof JellyfinError) {
      if (err.status === 401) return reply.code(401).send({ error: 'Jellyfin session expired' });
      req.log.error({ err }, 'jellyfin upstream error');
      return reply.code(502).send({ error: `Jellyfin upstream error (${err.status})` });
    }
    req.log.error({ err }, 'unhandled error');
    const e = err as { statusCode?: unknown; message?: string };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 500;
    reply.code(status).send({ error: status >= 500 ? 'Internal server error' : (e.message ?? 'Error') });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (req, reply) => {
    try {
      await deps.db.execute('select 1' as never);
      await deps.jellyfin.request('GET', '/System/Info/Public');
      return { status: 'ready' };
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'not ready' });
    }
  });

  await app.register(authRoutes(deps), { prefix: '/api/auth' });
  await app.register(libraryRoutes(deps), { prefix: '/api/library' });
  await app.register(mbRoutes(deps), { prefix: '/api/mb' });
  await app.register(requestRoutes(deps), { prefix: '/api/requests' });
  await app.register(eventRoutes(deps), { prefix: '/api/events' });
  await app.register(settingsRoutes(deps), { prefix: '/api/settings' });
  await app.register(playlistRoutes(deps), { prefix: '/api/playlists' });
  await app.register(publicPlaylistRoutes(deps), { prefix: '/api/public/playlists' });
  await app.register(playbackRoutes(deps), { prefix: '/api/playback' });
  await app.register(importRoutes(deps), { prefix: '/api/imports' });

  if (deps.config.webDist) {
    await app.register(fastifyStatic, { root: deps.config.webDist, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
