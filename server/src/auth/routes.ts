import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { schema } from '../db/index.js';
import { JellyfinError } from '../jellyfin/client.js';
import { buildSessionInfo, deviceIdFor, getUserRow } from './session.js';

const LoginBody = z.object({ username: z.string().min(1), password: z.string() });

export function authRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    app.post('/login', async (req, reply) => {
      const { username, password } = LoginBody.parse(req.body);
      const deviceId = deviceIdFor(username);
      let auth;
      try {
        auth = await deps.jellyfin.authenticateByName(username, password, deviceId);
      } catch (err) {
        if (err instanceof JellyfinError && (err.status === 401 || err.status === 400)) {
          return reply.code(401).send({ error: 'Invalid Jellyfin username or password' });
        }
        throw err;
      }
      const isAdmin = auth.User.Policy?.IsAdministrator ?? false;
      const [user] = await deps.db
        .insert(schema.users)
        .values({
          jellyfinUserId: auth.User.Id,
          username: auth.User.Name,
          isAdmin,
          jellyfinToken: auth.AccessToken,
          lastLoginAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.users.jellyfinUserId,
          set: {
            username: auth.User.Name,
            isAdmin,
            jellyfinToken: auth.AccessToken,
            lastLoginAt: new Date(),
          },
        })
        .returning();
      if (!user) throw new Error('failed to upsert user');
      const token = app.jwt.sign(
        { sub: user.id, jfUserId: user.jellyfinUserId, username: user.username, isAdmin: user.isAdmin },
        { expiresIn: '30d' },
      );
      return buildSessionInfo(deps.config, token, user);
    });

    app.get('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
      const user = await getUserRow(deps.db, req.user.sub);
      if (!user?.jellyfinToken) return reply.code(401).send({ error: 'Session expired' });
      try {
        await deps.jellyfin.me(user.jellyfinToken);
      } catch (err) {
        if (err instanceof JellyfinError && err.status === 401) {
          return reply.code(401).send({ error: 'Jellyfin session expired — please log in again' });
        }
        throw err;
      }
      const token = app.jwt.sign(
        { sub: user.id, jfUserId: user.jellyfinUserId, username: user.username, isAdmin: user.isAdmin },
        { expiresIn: '30d' },
      );
      return buildSessionInfo(deps.config, token, user);
    });
  };
}
