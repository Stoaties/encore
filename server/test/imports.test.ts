import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ImportBatch, ServerEvent } from '@encore/shared';
import { schema } from '../src/db/index.js';
import { classify, nameSimilarity, scoreMatch } from '../src/imports/matching.js';
import { parsePlaylistUrl, parseYtTitle } from '../src/imports/providers.js';
import { resolveImportBatch, type ImportCtx } from '../src/imports/service.js';
import { bearer, buildTestApp, fakeFetch, json, seedUser, setupTestDb, testConfig, truncateAll } from './helpers.js';

// ---------- pure units ----------

describe('parsePlaylistUrl', () => {
  it('parses spotify playlist/album/track links (incl. intl prefixes)', () => {
    expect(parsePlaylistUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x')).toEqual({
      source: 'spotify',
      id: 'playlist:37i9dQZF1DXcBWIGoYBM5M',
    });
    expect(parsePlaylistUrl('https://open.spotify.com/intl-fr/playlist/AbC123')).toEqual({
      source: 'spotify',
      id: 'playlist:AbC123',
    });
    expect(parsePlaylistUrl('https://open.spotify.com/album/AlbID')).toEqual({
      source: 'spotify',
      id: 'album:AlbID',
    });
    expect(parsePlaylistUrl('https://open.spotify.com/track/TrkID')).toEqual({
      source: 'spotify',
      id: 'track:TrkID',
    });
  });

  it('parses youtube playlist links on all hosts', () => {
    expect(parsePlaylistUrl('https://www.youtube.com/playlist?list=PL123')).toEqual({ source: 'youtube', id: 'PL123' });
    expect(parsePlaylistUrl('https://music.youtube.com/playlist?list=PLxyz')).toEqual({ source: 'youtube', id: 'PLxyz' });
    expect(parsePlaylistUrl('https://m.youtube.com/watch?v=abc&list=PL9')).toEqual({ source: 'youtube', id: 'PL9' });
  });

  it('rejects everything else', () => {
    expect(parsePlaylistUrl('https://example.com/playlist/1')).toBeNull();
    expect(parsePlaylistUrl('not a url')).toBeNull();
  });
});

describe('parseYtTitle', () => {
  it('splits "Artist - Title" and strips video noise', () => {
    expect(parseYtTitle('Radiohead - Karma Police (Official Video) [4K]')).toEqual({
      title: 'Karma Police',
      artist: 'Radiohead',
    });
    expect(parseYtTitle('MUSE — Uprising [Official Music Video]')).toEqual({ title: 'Uprising', artist: 'MUSE' });
  });

  it('falls back to the channel name, minus Topic/VEVO suffixes', () => {
    expect(parseYtTitle('Karma Police', 'Radiohead - Topic')).toEqual({ title: 'Karma Police', artist: 'Radiohead' });
    expect(parseYtTitle('Uprising (Lyrics)', 'MuseVEVO')).toEqual({ title: 'Uprising', artist: 'Muse' });
  });

  it('drops deleted/private placeholders', () => {
    expect(parseYtTitle('Deleted video')).toBeNull();
    expect(parseYtTitle('Private video', 'Whoever')).toBeNull();
  });
});

describe('matching', () => {
  it('nameSimilarity: exact > containment > token overlap', () => {
    expect(nameSimilarity('Karma Police', 'karma police')).toBe(1);
    expect(nameSimilarity('Creep', 'Creep (Acoustic)')).toBe(0.85);
    expect(nameSimilarity('Paranoid Android Live', 'Paranoid Android Remix')).toBeCloseTo(2 / 4);
    expect(nameSimilarity('Creep', 'Everything In Its Right Place')).toBe(0);
  });

  it('scoreMatch renormalizes when artist/duration are missing', () => {
    const src = { title: 'No Surprises' };
    expect(scoreMatch(src, { title: 'No Surprises', artistName: 'Whoever' })).toBe(1);
    const withArtist = { title: 'No Surprises', artist: 'Radiohead' };
    expect(scoreMatch(withArtist, { title: 'No Surprises', artistName: 'The Karaoke Crew' })).toBeCloseTo(0.625);
  });

  it('scoreMatch rewards close durations', () => {
    const src = { title: 'X', artist: 'Y', durationMs: 200_000 };
    const close = scoreMatch(src, { title: 'X', artistName: 'Y', durationMs: 203_000 });
    const far = scoreMatch(src, { title: 'X', artistName: 'Y', durationMs: 250_000 });
    expect(close).toBeGreaterThan(0.95);
    expect(far).toBeCloseTo(0.8); // duration contributes 0
  });

  it('classify maps scores to statuses', () => {
    expect(classify(0.9)).toBe('auto');
    expect(classify(0.6)).toBe('needs_review');
    expect(classify(0.2)).toBe('unmatched');
  });
});

// ---------- integration: create → resolve (auto-done) ----------

const KREC = 'dddddddd-0000-4000-8000-000000000001';
const NREC = 'dddddddd-0000-4000-8000-000000000002';
const PLAYLIST_URL = 'https://open.spotify.com/playlist/PLTEST1';

const credit = (name: string) => [{ name, artist: { id: 'cccccccc-0000-4000-8000-0000000000aa', name } }];
const rawRec = (id: string, title: string, artist: string, length: number | null) => ({
  id,
  title,
  length,
  'artist-credit': credit(artist),
  releases: [{ id: 'rel-x', title: 'OK Computer', 'release-group': { id: 'bbbbbbbb-0000-4000-8000-0000000000bb', title: 'OK Computer', 'primary-type': 'Album' } }],
});

const mbFetch = fakeFetch((url) => {
  if (url.pathname === '/ws/2/recording') {
    const q = url.searchParams.get('query') ?? '';
    if (q.includes('Karma Police')) return json({ recordings: [rawRec(KREC, 'Karma Police', 'Radiohead', 261_000)] });
    if (q.includes('No Surprises')) return json({ recordings: [rawRec(NREC, 'No Surprises', 'The Karaoke Crew', null)] });
    return json({ recordings: [] });
  }
  if (url.pathname === `/ws/2/recording/${KREC}`) return json(rawRec(KREC, 'Karma Police', 'Radiohead', 261_000));
  if (url.pathname === `/ws/2/recording/${NREC}`) return json(rawRec(NREC, 'No Surprises', 'The Karaoke Crew', null));
  return undefined;
});

/** Mock the Spotify embed page: return the tracks embedded in the __NEXT_DATA__
 *  script blob just like open.spotify.com/embed/playlist/{id} does in production. */
const spotifyEmbedHtml = (title: string, tracks: { title: string; subtitle: string; duration: number | null }[]) => {
  const entity = {
    type: 'playlist',
    name: title,
    coverArt: { sources: [{ url: 'https://i.scdn.co/image/mock-cover-640', width: 640 }] },
    trackList: tracks.map((t) => ({ title: t.title, subtitle: t.subtitle, duration: t.duration })),
  };
  const blob = { props: { pageProps: { state: { data: { entity } } } } };
  return `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(blob)}</script></head><body></body></html>`;
};

const spotifyFetch = fakeFetch((url) => {
  if (url.hostname === 'open.spotify.com' && url.pathname.startsWith('/embed/playlist/')) {
    const html = spotifyEmbedHtml('Road Trip', [
      { title: 'Karma Police', subtitle: 'Radiohead', duration: 261_000 },
      { title: 'No Surprises', subtitle: 'Radiohead', duration: 226_000 },
      { title: 'Obscure B-Side', subtitle: 'Nobody', duration: null },
    ]);
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  }
  // ignore cover-image fetches — resolve returns empty bytes so uploadPrimaryImage no-ops
  if (url.hostname === 'i.scdn.co') {
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  }
  return undefined;
});

describe('import flow', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>['db'];
  let pool: Awaited<ReturnType<typeof setupTestDb>>['pool'];

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  async function setup() {
    const user = await seedUser(db);
    const t = await buildTestApp(db, { mbFetch });
    // Stub Jellyfin so resolve doesn't try to hit a real server for playlist create
    vi.spyOn(t.jellyfin, 'items').mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    vi.spyOn(t.jellyfin, 'createPlaylist').mockResolvedValue({ Id: 'jf-playlist-1' });
    const ctx: ImportCtx = {
      db,
      config: testConfig(),
      mb: t.mb,
      jellyfin: t.jellyfin,
      events: t.events,
      fetchImpl: spotifyFetch,
    };
    return { ...t, user, ctx, auth: { authorization: bearer(t.app, user) } };
  }

  it('creates a batch and queues a resolve job', async () => {
    const { app, auth } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/imports', headers: auth, payload: { url: PLAYLIST_URL } });
    expect(res.statusCode).toBe(201);
    const batch = res.json() as ImportBatch;
    expect(batch.source).toBe('spotify');
    expect(batch.status).toBe('resolving');
    const jobs = await db.query.jobs.findMany({ where: eq(schema.jobs.type, 'import-resolve') });
    expect(jobs).toHaveLength(1);
    expect((jobs[0]!.payload as { batchId: string }).batchId).toBe(batch.id);
  });

  it('rejects unrecognized URLs and missing YouTube API key with 400', async () => {
    const { app, auth } = await setup();
    const bad = await app.inject({ method: 'POST', url: '/api/imports', headers: auth, payload: { url: 'https://example.com/x' } });
    expect(bad.statusCode).toBe(400);

    const noYt = await buildTestApp(db, { mbFetch });
    const res = await noYt.app.inject({
      method: 'POST',
      url: '/api/imports',
      headers: { authorization: bearer(noYt.app, await seedUser(db, { username: 'user2' })) },
      payload: { url: 'https://www.youtube.com/playlist?list=PL999' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not configured/);
  });

  it('resolves the playlist, matches items, and lands in "done" with cover + jellyfinPlaylistId', async () => {
    const { app, auth, ctx, events } = await setup();
    const seen: ServerEvent[] = [];
    events.subscribe((e) => {
      if (e.kind === 'import-updated') seen.push(e);
    });
    const created = (
      await app.inject({ method: 'POST', url: '/api/imports', headers: auth, payload: { url: PLAYLIST_URL } })
    ).json() as ImportBatch;

    await resolveImportBatch(ctx, created.id, async () => {});

    const res = await app.inject({ method: 'GET', url: `/api/imports/${created.id}`, headers: auth });
    const batch = res.json() as ImportBatch;
    expect(batch.status).toBe('done');
    expect(batch.title).toBe('Road Trip');
    expect(batch.coverUrl).toBe('https://i.scdn.co/image/mock-cover-640');
    expect(batch.items).toHaveLength(3);

    const [karma, surprises, obscure] = batch.items;
    expect(karma).toMatchObject({ sourceTitle: 'Karma Police', matchMbRecordingId: KREC });
    expect(karma!.matchScore).toBeGreaterThan(0.95);
    expect(surprises).toMatchObject({ sourceTitle: 'No Surprises', matchMbRecordingId: NREC });
    expect(obscure).toMatchObject({ sourceTitle: 'Obscure B-Side', matchStatus: 'unmatched', matchMbRecordingId: null });

    expect(seen.at(-1)).toMatchObject({ kind: 'import-updated', batchId: created.id, status: 'done' });
  });

  it('POST /items/:itemId/request creates an Encore track request for a missing item', async () => {
    const { app, auth, ctx, user } = await setup();
    const created = (
      await app.inject({ method: 'POST', url: '/api/imports', headers: auth, payload: { url: PLAYLIST_URL } })
    ).json() as ImportBatch;
    await resolveImportBatch(ctx, created.id, async () => {});
    const items = ((await app.inject({ method: 'GET', url: `/api/imports/${created.id}`, headers: auth })).json() as ImportBatch).items;
    const karma = items.find((i) => i.sourceTitle === 'Karma Police')!;

    const res = await app.inject({
      method: 'POST',
      url: `/api/imports/${created.id}/items/${karma.id}/request`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as ImportBatch;
    const updatedKarma = updated.items.find((i) => i.sourceTitle === 'Karma Police')!;
    expect(updatedKarma.requestId).toBeTruthy();

    const reqs = await db.query.requests.findMany({ where: eq(schema.requests.requestedBy, user.id) });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.type).toBe('track');
    expect(reqs[0]!.mbRecordingId).toBe(KREC);
  });

  it('other users cannot see or act on someone else’s batch', async () => {
    const { app, auth } = await setup();
    const created = (
      await app.inject({ method: 'POST', url: '/api/imports', headers: auth, payload: { url: PLAYLIST_URL } })
    ).json() as ImportBatch;
    const other = await seedUser(db, { username: 'nosy' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/imports/${created.id}`,
      headers: { authorization: bearer(app, other) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a deleted batch makes resolve abort quietly', async () => {
    const { app, auth, ctx } = await setup();
    const created = (
      await app.inject({ method: 'POST', url: '/api/imports', headers: auth, payload: { url: PLAYLIST_URL } })
    ).json() as ImportBatch;
    await app.inject({ method: 'DELETE', url: `/api/imports/${created.id}`, headers: auth });
    await expect(resolveImportBatch(ctx, created.id, async () => {})).resolves.toBeUndefined();
    expect(await db.query.importBatches.findFirst({ where: eq(schema.importBatches.id, created.id) })).toBeUndefined();
  });
});
