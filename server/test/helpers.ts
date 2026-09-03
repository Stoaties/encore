import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createDb, runMigrations, schema, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { MusicBrainzClient } from '../src/musicbrainz/client.js';
import { EventBus } from '../src/events.js';
import type { UserRow } from '../src/auth/session.js';

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://musicapp:musicapp@localhost:5433/musicapp';
const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://musicapp:musicapp@localhost:5433/musicapp_test';

export async function setupTestDb() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const r = await admin.query("SELECT 1 FROM pg_database WHERE datname='musicapp_test'");
  if (!r.rowCount) await admin.query('CREATE DATABASE musicapp_test');
  await admin.end();
  const { db, pool } = createDb(TEST_URL);
  await runMigrations(db, fileURLToPath(new URL('../drizzle', import.meta.url)));
  return { db, pool };
}

export async function truncateAll(db: Db) {
  await db.execute(
    sql`TRUNCATE users, requests, jobs, job_logs, track_plays, import_batches, import_items, mb_cache, settings CASCADE`,
  );
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: TEST_URL,
    jellyfinUrl: 'http://jellyfin.test',
    jellyfinPublicUrl: 'http://jellyfin.public.test',
    jellyfinApiKey: 'test-api-key',
    jwtSecret: 'test-secret-shhh',
    musicLibraryPath: '/tmp/encore-test/library',
    stagingPath: '/tmp/encore-test/staging',
    slskdUrl: 'http://slskd.test',
    slskdApiKey: 'slskd-key',
    slskdDownloadsPath: undefined,
    musicbrainzUserAgent: 'EncoreTest/0.0.0',
    youtubeApiKey: undefined,
    youtubeApiUrl: 'http://youtube.test/v3',
    spotdlWebUrl: 'http://spotdl-web.test',
    port: 0,
    webDist: undefined,
    isProd: false,
    ...overrides,
  };
}

export type FetchRoute = (url: URL, init: RequestInit & { method?: string }) => Response | Promise<Response> | undefined;

/** Build a fetch impl from a list of matchers; first non-undefined response wins. */
export function fakeFetch(...routes: FetchRoute[]): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    for (const route of routes) {
      const res = await route(url, init ?? {});
      if (res) return res;
    }
    return new Response(`no fake route for ${init?.method ?? 'GET'} ${url.pathname}`, { status: 404 });
  }) as typeof fetch;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Empty Jellyfin /Items result — "nothing in library". */
export const emptyItems: FetchRoute = (url) =>
  url.pathname === '/Items' || url.pathname === '/Artists/AlbumArtists'
    ? json({ Items: [], TotalRecordCount: 0, StartIndex: 0 })
    : undefined;

export async function buildTestApp(
  db: Db,
  opts: { jellyfin?: JellyfinClient; mbFetch?: typeof fetch; config?: Partial<Config> } = {},
) {
  const jellyfin = opts.jellyfin ?? new JellyfinClient('http://jellyfin.test', fakeFetch(emptyItems));
  const mb = new MusicBrainzClient({
    db,
    userAgent: 'EncoreTest/0.0.0',
    fetchImpl: opts.mbFetch ?? fakeFetch(),
    minIntervalMs: 0,
    retry503Ms: 0,
  });
  const events = new EventBus();
  const app = await buildApp({ config: testConfig(opts.config), db, jellyfin, mb, events });
  return { app, mb, events, jellyfin };
}

export async function seedUser(db: Db, opts: { username?: string; isAdmin?: boolean } = {}): Promise<UserRow> {
  const username = opts.username ?? 'user1';
  const [row] = await db
    .insert(schema.users)
    .values({
      jellyfinUserId: `jf-${username}`,
      username,
      isAdmin: opts.isAdmin ?? false,
      jellyfinToken: `jf-token-${username}`,
    })
    .returning();
  return row!;
}

export function bearer(app: FastifyInstance, user: UserRow): string {
  const token = app.jwt.sign({
    sub: user.id,
    jfUserId: user.jellyfinUserId,
    username: user.username,
    isAdmin: user.isAdmin,
  });
  return `Bearer ${token}`;
}
