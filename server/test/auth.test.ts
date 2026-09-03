import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '@encore/shared';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { schema } from '../src/db/index.js';
import { buildTestApp, fakeFetch, json, setupTestDb, truncateAll } from './helpers.js';

const JF_TOKEN = 'jf-token-abc';

function fakeJellyfin(opts: { adminUser?: boolean; revoked?: boolean } = {}) {
  return new JellyfinClient(
    'http://jellyfin.test',
    fakeFetch((url, init) => {
      if (url.pathname === '/Users/AuthenticateByName' && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.Username === 'stoat' && body.Pw === 'goodpass') {
          return json({
            User: { Id: 'jf-user-1', Name: 'stoat', Policy: { IsAdministrator: opts.adminUser ?? false } },
            AccessToken: JF_TOKEN,
          });
        }
        return new Response('Unauthorized', { status: 401 });
      }
      if (url.pathname === '/Users/Me') {
        const auth = (init.headers as Record<string, string>).Authorization ?? '';
        if (!opts.revoked && auth.includes(`Token="${JF_TOKEN}"`)) {
          return json({ Id: 'jf-user-1', Name: 'stoat' });
        }
        return new Response('Unauthorized', { status: 401 });
      }
      return undefined;
    }),
  );
}

let ctx: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(async () => {
  await ctx.pool.end();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

async function makeApp(jf = fakeJellyfin()) {
  const { app } = await buildTestApp(ctx.db, { jellyfin: jf });
  return app;
}

describe('auth flow', () => {
  it('logs in with valid Jellyfin credentials and issues a session', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'stoat', password: 'goodpass' },
    });
    expect(res.statusCode).toBe(200);
    const session = res.json() as SessionInfo;
    expect(session.token).toBeTruthy();
    expect(session.user.username).toBe('stoat');
    expect(session.user.isAdmin).toBe(false);
    expect(session.jellyfin.baseUrl).toBe('http://jellyfin.public.test');
    expect(session.jellyfin.token).toBe(JF_TOKEN);
    expect(session.jellyfin.userId).toBe('jf-user-1');

    const rows = await ctx.db.select().from(schema.users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jellyfinToken).toBe(JF_TOKEN);
    await app.close();
  });

  it('rejects invalid credentials with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'stoat', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect((await ctx.db.select().from(schema.users)).length).toBe(0);
    await app.close();
  });

  it('mirrors Jellyfin admin role', async () => {
    const app = await makeApp(fakeJellyfin({ adminUser: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'stoat', password: 'goodpass' },
    });
    expect((res.json() as SessionInfo).user.isAdmin).toBe(true);
    await app.close();
  });

  it('re-login upserts the same user row', async () => {
    const app = await makeApp();
    for (let i = 0; i < 2; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'stoat', password: 'goodpass' } });
    }
    expect((await ctx.db.select().from(schema.users)).length).toBe(1);
    await app.close();
  });

  it('serves /me for a valid session and 401s without a token', async () => {
    const app = await makeApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'stoat', password: 'goodpass' },
    });
    const { token } = login.json() as SessionInfo;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as SessionInfo).user.username).toBe('stoat');

    const anon = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anon.statusCode).toBe(401);
    await app.close();
  });

  it('401s /me when the stored Jellyfin token is no longer valid', async () => {
    const appOk = await makeApp();
    const login = await appOk.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'stoat', password: 'goodpass' },
    });
    const { token } = login.json() as SessionInfo;
    await appOk.close();

    const appRevoked = await makeApp(fakeJellyfin({ revoked: true }));
    const me = await appRevoked.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
    await appRevoked.close();
  });
});
