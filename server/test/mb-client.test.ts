import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { MusicBrainzClient } from '../src/musicbrainz/client.js';
import { fakeFetch, json, setupTestDb, truncateAll } from './helpers.js';

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

const artistPayload = { artists: [{ id: 'a1', name: 'Nirvana', country: 'US', score: 100 }] };

function countingFetch(handler: Parameters<typeof fakeFetch>[0]) {
  let count = 0;
  const impl = fakeFetch((url, init) => {
    const res = handler(url, init);
    if (res) count += 1;
    return res;
  });
  return { impl, hits: () => count };
}

function makeClient(fetchImpl: typeof fetch, opts: { minIntervalMs?: number } = {}) {
  return new MusicBrainzClient({
    db: ctx.db,
    userAgent: 'EncoreTest/0.0.0 (test)',
    fetchImpl,
    minIntervalMs: opts.minIntervalMs ?? 0,
    retry503Ms: 0,
  });
}

describe('musicbrainz client', () => {
  it('caches identical queries in postgres and skips the network', async () => {
    const { impl, hits } = countingFetch((url) => (url.pathname === '/ws/2/artist' ? json(artistPayload) : undefined));
    const mb = makeClient(impl);
    const first = await mb.searchArtists('nirvana');
    expect(first[0]!.name).toBe('Nirvana');
    await mb.searchArtists('nirvana');
    expect(hits()).toBe(1);
    expect(await ctx.db.select().from(schema.mbCache)).toHaveLength(1);

    await mb.searchArtists('other query');
    expect(hits()).toBe(2);

    // a second client instance (fresh process) reuses the shared cache
    const mb2 = makeClient(impl);
    await mb2.searchArtists('nirvana');
    expect(hits()).toBe(2);
  });

  it('refetches once the cache entry is older than the TTL', async () => {
    const { impl, hits } = countingFetch((url) => (url.pathname === '/ws/2/artist' ? json(artistPayload) : undefined));
    const mb = makeClient(impl);
    await mb.searchArtists('nirvana');
    await ctx.db.update(schema.mbCache).set({ fetchedAt: new Date(Date.now() - 48 * 3600_000) });
    await mb.searchArtists('nirvana');
    expect(hits()).toBe(2);
  });

  it('spaces real network hits by minIntervalMs (1 req/s policy)', async () => {
    const { impl } = countingFetch((url) => (url.pathname === '/ws/2/artist' ? json(artistPayload) : undefined));
    const mb = makeClient(impl, { minIntervalMs: 120 });
    const started = Date.now();
    await Promise.all([mb.searchArtists('one'), mb.searchArtists('two'), mb.searchArtists('three')]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(230);
  });

  it('retries after a transient 503 from MusicBrainz', async () => {
    let calls = 0;
    const impl = fakeFetch((url) => {
      if (url.pathname !== '/ws/2/artist') return undefined;
      calls += 1;
      return calls === 1 ? new Response('throttled', { status: 503 }) : json(artistPayload);
    });
    const mb = makeClient(impl);
    const res = await mb.searchArtists('nirvana');
    expect(res).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('gives up after three attempts of sustained 503', async () => {
    let calls = 0;
    const impl = fakeFetch((url) => {
      if (url.pathname !== '/ws/2/artist') return undefined;
      calls += 1;
      return new Response('throttled', { status: 503 });
    });
    const mb = makeClient(impl);
    await expect(mb.searchArtists('nirvana')).rejects.toThrow(/503/);
    expect(calls).toBe(3);
  });

  it('sends the configured User-Agent', async () => {
    let ua = '';
    const impl = fakeFetch((url, init) => {
      if (url.pathname !== '/ws/2/artist') return undefined;
      ua = (init.headers as Record<string, string>)['User-Agent'] ?? '';
      return json(artistPayload);
    });
    await makeClient(impl).searchArtists('nirvana');
    expect(ua).toBe('EncoreTest/0.0.0 (test)');
  });

  it('maps release-group search results including artist credit join phrases', async () => {
    const impl = fakeFetch((url) =>
      url.pathname === '/ws/2/release-group'
        ? json({
            'release-groups': [
              {
                id: 'rg-1',
                title: 'Collab Album',
                'first-release-date': '1994-09-13',
                'primary-type': 'Album',
                'secondary-types': ['Compilation'],
                'artist-credit': [
                  { name: 'Artist A', joinphrase: ' & ', artist: { id: 'a-1', name: 'Artist A' } },
                  { name: 'Artist B', artist: { id: 'a-2', name: 'Artist B' } },
                ],
                score: 97,
              },
            ],
          })
        : undefined,
    );
    const [rg] = await makeClient(impl).searchReleaseGroups('collab');
    expect(rg).toMatchObject({
      mbid: 'rg-1',
      title: 'Collab Album',
      artistName: 'Artist A & Artist B',
      artistMbid: 'a-1',
      year: 1994,
      primaryType: 'Album',
      secondaryTypes: ['Compilation'],
      score: 97,
    });
    expect(rg!.coverUrl).toBe('https://coverartarchive.org/release-group/rg-1/front-250');
  });

  it('prefers a plain Album release group when mapping recordings', async () => {
    const impl = fakeFetch((url) =>
      url.pathname === '/ws/2/recording/rec-1'
        ? json({
            id: 'rec-1',
            title: 'Some Song',
            length: 215000,
            'artist-credit': [{ name: 'Artist A', artist: { id: 'a-1', name: 'Artist A' } }],
            releases: [
              { id: 'r-single', title: 'Some Song (Single)', 'release-group': { id: 'rg-single', title: 'Some Song', 'primary-type': 'Single' } },
              { id: 'r-album', title: 'The Album', 'release-group': { id: 'rg-album', title: 'The Album', 'primary-type': 'Album' } },
            ],
          })
        : undefined,
    );
    const rec = await makeClient(impl).lookupRecording('rec-1');
    expect(rec.releaseGroupMbid).toBe('rg-album');
    expect(rec.releaseTitle).toBe('The Album');
    expect(rec.durationMs).toBe(215000);
  });
});
