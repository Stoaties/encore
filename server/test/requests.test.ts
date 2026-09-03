import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { MusicRequest, ServerEvent } from '@encore/shared';
import { schema } from '../src/db/index.js';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { bearer, buildTestApp, emptyItems, fakeFetch, json, seedUser, setupTestDb, truncateAll } from './helpers.js';

const REC = 'aaaaaaaa-0000-4000-8000-000000000001';
const REC2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const RG = 'bbbbbbbb-0000-4000-8000-000000000001';
const RG_MISSING = 'bbbbbbbb-0000-4000-8000-000000000002';
const RG_LIVE = 'bbbbbbbb-0000-4000-8000-000000000003';
const RG_INLIB = 'bbbbbbbb-0000-4000-8000-000000000004';
const ART = 'cccccccc-0000-4000-8000-000000000001';

const credit = [{ name: 'Fixture Artist', artist: { id: ART, name: 'Fixture Artist' } }];

const mbFetch = fakeFetch((url) => {
  const recording = (id: string, title: string) => ({
    id,
    title,
    length: 200_000,
    'artist-credit': credit,
    releases: [{ id: 'rel-1', title: 'Fixture Album', 'release-group': { id: RG, title: 'Fixture Album', 'primary-type': 'Album' } }],
  });
  if (url.pathname === `/ws/2/recording/${REC}`) return json(recording(REC, 'Fixture Song'));
  if (url.pathname === `/ws/2/recording/${REC2}`) return json(recording(REC2, 'Second Song'));
  if (url.pathname === `/ws/2/release-group/${RG}`) {
    return json({ id: RG, title: 'Fixture Album', 'first-release-date': '2020-05-01', 'primary-type': 'Album', 'artist-credit': credit });
  }
  if (url.pathname === `/ws/2/artist/${ART}`) return json({ id: ART, name: 'Fixture Artist', country: 'CA' });
  if (url.pathname === '/ws/2/release-group' && url.searchParams.get('artist') === ART) {
    return json({
      'release-group-count': 3,
      'release-groups': [
        { id: RG_MISSING, title: 'Missing Album', 'first-release-date': '2021-01-01', 'primary-type': 'Album', 'artist-credit': credit },
        { id: RG_LIVE, title: 'Live Album', 'primary-type': 'Album', 'secondary-types': ['Live'], 'artist-credit': credit },
        { id: RG_INLIB, title: 'Owned Album', 'primary-type': 'EP', 'artist-credit': credit },
      ],
    });
  }
  return undefined;
});

/** Jellyfin fake whose library contains exactly one album, tagged with RG_INLIB. */
const jfWithOwnedAlbum = () =>
  new JellyfinClient(
    'http://jellyfin.test',
    fakeFetch((url) => {
      if (url.pathname === '/Items' && url.searchParams.get('IncludeItemTypes') === 'MusicAlbum') {
        return json({
          Items: [
            {
              Id: 'jf-album-1',
              Name: 'Owned Album',
              AlbumArtist: 'Fixture Artist',
              ProviderIds: { MusicBrainzReleaseGroup: RG_INLIB },
            },
          ],
          TotalRecordCount: 1,
          StartIndex: 0,
        });
      }
      return emptyItems(url, {});
    }),
  );

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

const makeApp = (jellyfin?: JellyfinClient) => buildTestApp(ctx.db, { mbFetch, jellyfin });

async function jobsFor(requestId: string) {
  return ctx.db.select().from(schema.jobs).where(eq(schema.jobs.requestId, requestId));
}

describe('request lifecycle', () => {
  it('creates a pending track request for a regular user', async () => {
    const { app } = await makeApp();
    const user = await seedUser(ctx.db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, user) },
      payload: { type: 'track', mbid: REC },
    });
    expect(res.statusCode).toBe(201);
    const request = res.json() as MusicRequest;
    expect(request.status).toBe('pending');
    expect(request.type).toBe('track');
    expect(request.trackTitle).toBe('Fixture Song');
    expect(request.artistName).toBe('Fixture Artist');
    expect(request.albumTitle).toBe('Fixture Album');
    expect(request.mbRecordingId).toBe(REC);
    expect(request.mbReleaseGroupId).toBe(RG);
    expect(request.requestedBy.username).toBe('user1');
    expect(await jobsFor(request.id)).toHaveLength(0);
    await app.close();
  });

  it('auto-approves admin requests and enqueues an acquire job', async () => {
    const { app, events } = await makeApp();
    const admin = await seedUser(ctx.db, { username: 'boss', isAdmin: true });
    const seen: ServerEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const res = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, admin) },
      payload: { type: 'album', mbid: RG },
    });
    expect(res.statusCode).toBe(201);
    const request = res.json() as MusicRequest;
    expect(request.status).toBe('approved');
    expect(request.year).toBe(2020);
    const jobs = await jobsFor(request.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('acquire-request');
    expect(jobs[0]!.status).toBe('pending');
    expect(seen.some((e) => e.kind === 'request-updated' && e.request.id === request.id)).toBe(true);
    await app.close();
  });

  it('rejects a duplicate open request with 409', async () => {
    const { app } = await makeApp();
    const user = await seedUser(ctx.db);
    const first = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, user) },
      payload: { type: 'album', mbid: RG },
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, user) },
      payload: { type: 'album', mbid: RG },
    });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { error: string }).error).toMatch(/already requested/i);
    await app.close();
  });

  it('rejects albums already in the Jellyfin library', async () => {
    const { app } = await makeApp(
      new JellyfinClient(
        'http://jellyfin.test',
        fakeFetch((url) => {
          if (url.pathname === '/Items') {
            return json({
              Items: [{ Id: 'jf-1', Name: 'Fixture Album', AlbumArtist: 'Fixture Artist' }],
              TotalRecordCount: 1,
              StartIndex: 0,
            });
          }
          return undefined;
        }),
      ),
    );
    const user = await seedUser(ctx.db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, user) },
      payload: { type: 'album', mbid: RG },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/already in the library/i);
    await app.close();
  });

  it('enforces the per-user daily quota', async () => {
    const { app } = await makeApp();
    const admin = await seedUser(ctx.db, { username: 'boss', isAdmin: true });
    const user = await seedUser(ctx.db);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: bearer(app, admin) },
      payload: { quotaPerUserPerDay: 1 },
    });
    expect(put.statusCode).toBe(200);

    const first = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, user) },
      payload: { type: 'track', mbid: REC },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, user) },
      payload: { type: 'track', mbid: REC2 },
    });
    expect(second.statusCode).toBe(429);

    // admins are exempt from quotas
    const adminReq = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, admin) },
      payload: { type: 'track', mbid: REC2 },
    });
    expect(adminReq.statusCode).toBe(201);
    await app.close();
  });

  it('approve: pending -> approved with job; deny only works on pending', async () => {
    const { app, events } = await makeApp();
    const user = await seedUser(ctx.db);
    const admin = await seedUser(ctx.db, { username: 'boss', isAdmin: true });
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/requests',
        headers: { authorization: bearer(app, user) },
        payload: { type: 'album', mbid: RG },
      })
    ).json() as MusicRequest;
    expect(created.status).toBe('pending');

    const seen: ServerEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const approved = await app.inject({
      method: 'POST',
      url: `/api/requests/${created.id}/approve`,
      headers: { authorization: bearer(app, admin) },
    });
    expect(approved.statusCode).toBe(200);
    expect((approved.json() as MusicRequest).status).toBe('approved');
    expect(await jobsFor(created.id)).toHaveLength(1);
    expect(seen).toHaveLength(1);

    const deny = await app.inject({
      method: 'POST',
      url: `/api/requests/${created.id}/deny`,
      headers: { authorization: bearer(app, admin) },
    });
    expect(deny.statusCode).toBe(409);
    await app.close();
  });

  it('deny: pending -> denied; non-admins cannot moderate', async () => {
    const { app } = await makeApp();
    const user = await seedUser(ctx.db);
    const admin = await seedUser(ctx.db, { username: 'boss', isAdmin: true });
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/requests',
        headers: { authorization: bearer(app, user) },
        payload: { type: 'album', mbid: RG },
      })
    ).json() as MusicRequest;

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/requests/${created.id}/approve`,
      headers: { authorization: bearer(app, user) },
    });
    expect(forbidden.statusCode).toBe(403);

    const denied = await app.inject({
      method: 'POST',
      url: `/api/requests/${created.id}/deny`,
      headers: { authorization: bearer(app, admin) },
    });
    expect((denied.json() as MusicRequest).status).toBe('denied');
    expect(await jobsFor(created.id)).toHaveLength(0);
    await app.close();
  });

  it('retry: failed -> approved and re-enqueues', async () => {
    const { app } = await makeApp();
    const admin = await seedUser(ctx.db, { username: 'boss', isAdmin: true });
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/requests',
        headers: { authorization: bearer(app, admin) },
        payload: { type: 'album', mbid: RG },
      })
    ).json() as MusicRequest;
    await ctx.db
      .update(schema.requests)
      .set({ status: 'failed', errorMessage: 'no candidates' })
      .where(eq(schema.requests.id, created.id));

    const retried = await app.inject({
      method: 'POST',
      url: `/api/requests/${created.id}/retry`,
      headers: { authorization: bearer(app, admin) },
    });
    expect(retried.statusCode).toBe(200);
    const body = retried.json() as MusicRequest;
    expect(body.status).toBe('approved');
    expect(body.errorMessage).toBeNull();
    expect(await jobsFor(created.id)).toHaveLength(2);
    await app.close();
  });

  it('expands an artist request into child album requests, skipping live/owned releases', async () => {
    const { app } = await makeApp(jfWithOwnedAlbum());
    const admin = await seedUser(ctx.db, { username: 'boss', isAdmin: true });
    const res = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, admin) },
      payload: { type: 'artist', mbid: ART },
    });
    expect(res.statusCode).toBe(201);
    const parent = res.json() as MusicRequest;
    expect(parent.type).toBe('artist');
    expect(parent.status).toBe('approved');
    expect(parent.children).toHaveLength(1);
    const child = parent.children![0]!;
    expect(child.mbReleaseGroupId).toBe(RG_MISSING);
    expect(child.albumTitle).toBe('Missing Album');
    expect(await jobsFor(child.id)).toHaveLength(1);
    expect(await jobsFor(parent.id)).toHaveLength(0);
    await app.close();
  });

  it('owners can delete their own pending requests; others cannot', async () => {
    const { app } = await makeApp();
    const user = await seedUser(ctx.db);
    const other = await seedUser(ctx.db, { username: 'other' });
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/requests',
        headers: { authorization: bearer(app, user) },
        payload: { type: 'album', mbid: RG },
      })
    ).json() as MusicRequest;

    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/requests/${created.id}`,
      headers: { authorization: bearer(app, other) },
    });
    expect(forbidden.statusCode).toBe(403);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/requests/${created.id}`,
      headers: { authorization: bearer(app, user) },
    });
    expect(del.statusCode).toBe(204);
    expect(await ctx.db.select().from(schema.requests)).toHaveLength(0);
    await app.close();
  });

  it('lists requests with scope filtering', async () => {
    const { app } = await makeApp();
    const user = await seedUser(ctx.db);
    const other = await seedUser(ctx.db, { username: 'other' });
    await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, user) },
      payload: { type: 'album', mbid: RG },
    });
    await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, other) },
      payload: { type: 'track', mbid: REC },
    });

    const all = await app.inject({ method: 'GET', url: '/api/requests', headers: { authorization: bearer(app, user) } });
    expect(all.json()).toHaveLength(2);
    const mine = await app.inject({
      method: 'GET',
      url: '/api/requests?scope=mine',
      headers: { authorization: bearer(app, user) },
    });
    const mineList = mine.json() as MusicRequest[];
    expect(mineList).toHaveLength(1);
    expect(mineList[0]!.requestedBy.username).toBe('user1');
    await app.close();
  });
});

describe('settings', () => {
  it('admin can read and patch settings; non-admin gets 403', async () => {
    const { app } = await makeApp();
    const admin = await seedUser(ctx.db, { username: 'boss', isAdmin: true });
    const user = await seedUser(ctx.db);

    const forbidden = await app.inject({ method: 'GET', url: '/api/settings', headers: { authorization: bearer(app, user) } });
    expect(forbidden.statusCode).toBe(403);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: bearer(app, admin) },
      payload: { autoApprove: { users: true }, quality: { minBitrateKbps: 256 } },
    });
    expect(put.statusCode).toBe(200);
    const updated = put.json() as { autoApprove: { users: boolean; admins: boolean }; quality: { minBitrateKbps: number; preferredFormats: string[] } };
    expect(updated.autoApprove.users).toBe(true);
    expect(updated.autoApprove.admins).toBe(true);
    expect(updated.quality.minBitrateKbps).toBe(256);
    expect(updated.quality.preferredFormats).toEqual(['flac', 'mp3']);

    // persisted: user requests are now auto-approved
    const created = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { authorization: bearer(app, user) },
      payload: { type: 'album', mbid: RG },
    });
    expect((created.json() as MusicRequest).status).toBe('approved');
    await app.close();
  });
});
