import { eq, sql } from 'drizzle-orm';
import {
  caaCoverUrl,
  type MbArtistResult,
  type MbRecordingResult,
  type MbReleaseGroupResult,
  type MbTracklist,
} from '@encore/shared';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';

const MB_BASE = 'https://musicbrainz.org/ws/2';

export const TTL = {
  search: 24 * 3600_000,
  browse: 24 * 3600_000,
  lookup: 7 * 24 * 3600_000,
} as const;

export class MusicBrainzError extends Error {
  constructor(
    public status: number,
    message?: string,
  ) {
    super(message ?? `MusicBrainz error (${status})`);
    this.name = 'MusicBrainzError';
  }
}

// ---- raw MB json shapes (only the fields we consume) ----
interface RawArtistCredit {
  name: string;
  joinphrase?: string;
  artist?: { id: string; name: string };
}
interface RawArtist {
  id: string;
  name: string;
  disambiguation?: string;
  country?: string;
  type?: string;
  score?: number;
}
interface RawReleaseGroup {
  id: string;
  title: string;
  'first-release-date'?: string;
  'primary-type'?: string;
  'secondary-types'?: string[];
  'artist-credit'?: RawArtistCredit[];
  score?: number;
}
interface RawReleaseRef {
  id: string;
  title: string;
  status?: string;
  country?: string;
  date?: string;
  media?: { format?: string; 'track-count'?: number }[];
}
interface RawReleaseFull {
  id: string;
  title: string;
  date?: string;
  'artist-credit'?: RawArtistCredit[];
  media?: {
    position?: number;
    tracks?: {
      position?: number;
      title?: string;
      length?: number;
      'artist-credit'?: RawArtistCredit[];
      recording?: { id: string; title?: string; length?: number };
    }[];
  }[];
}
interface RawRecording {
  id: string;
  title: string;
  length?: number;
  'artist-credit'?: RawArtistCredit[];
  releases?: {
    id: string;
    title: string;
    'release-group'?: RawReleaseGroup;
  }[];
  score?: number;
}

export function creditName(credit?: RawArtistCredit[]): string {
  if (!credit?.length) return 'Unknown Artist';
  return credit.map((c) => c.name + (c.joinphrase ?? '')).join('');
}

const yearOf = (date?: string): number | null => {
  const y = date ? Number.parseInt(date.slice(0, 4), 10) : NaN;
  return Number.isFinite(y) ? y : null;
};

export interface MbClientOptions {
  db: Db;
  userAgent: string;
  fetchImpl?: typeof fetch;
  /** min spacing between real MB hits; MB policy is 1 req/s */
  minIntervalMs?: number;
  /** backoff before the single retry after an MB 503 */
  retry503Ms?: number;
}

export class MusicBrainzClient {
  private db: Db;
  private userAgent: string;
  private fetchImpl: typeof fetch;
  private minIntervalMs: number;
  private retry503Ms: number;
  private chain: Promise<unknown> = Promise.resolve();
  private lastHitAt = 0;

  constructor(opts: MbClientOptions) {
    this.db = opts.db;
    this.userAgent = opts.userAgent;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? 1100;
    this.retry503Ms = opts.retry503Ms ?? 2000;
  }

  /** Serializes all real MB hits and enforces the 1 req/s policy. */
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastHitAt + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.lastHitAt = Date.now();
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async fetchJson<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ ...params, fmt: 'json' });
    const url = `${MB_BASE}${path}?${qs.toString()}`;
    const doFetch = () =>
      this.fetchImpl(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' } });
    let res = await this.throttled(doFetch);
    // MB search intermittently 503s even under the 1 req/s policy — back off and
    // retry twice before giving up
    for (let attempt = 0; res.status === 503 && attempt < 2; attempt++) {
      await new Promise((r) => setTimeout(r, this.retry503Ms * (attempt + 1)));
      res = await this.throttled(doFetch);
    }
    if (!res.ok) throw new MusicBrainzError(res.status, `MusicBrainz ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  private async cached<T>(path: string, params: Record<string, string>, ttlMs: number): Promise<T> {
    const key = `${path}?${new URLSearchParams(params).toString()}`;
    const row = await this.db.query.mbCache.findFirst({ where: eq(schema.mbCache.key, key) });
    if (row && Date.now() - row.fetchedAt.getTime() < ttlMs) return row.payload as T;
    const payload = await this.fetchJson<T>(path, params);
    await this.db
      .insert(schema.mbCache)
      .values({ key, payload, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.mbCache.key,
        set: { payload, fetchedAt: new Date() },
      });
    return payload;
  }

  /** Drop cache rows past the longest TTL (called opportunistically). */
  async pruneCache(): Promise<void> {
    await this.db
      .delete(schema.mbCache)
      .where(sql`${schema.mbCache.fetchedAt} < now() - interval '30 days'`);
  }

  // ---- searches ----

  async searchArtists(q: string, limit = 8): Promise<MbArtistResult[]> {
    const data = await this.cached<{ artists?: RawArtist[] }>(
      '/artist',
      { query: q, limit: String(limit) },
      TTL.search,
    );
    return (data.artists ?? []).map((a) => ({
      mbid: a.id,
      name: a.name,
      disambiguation: a.disambiguation || null,
      country: a.country ?? null,
      type: a.type ?? null,
      score: a.score ?? 0,
    }));
  }

  async searchReleaseGroups(q: string, limit = 12): Promise<MbReleaseGroupResult[]> {
    const data = await this.cached<{ 'release-groups'?: RawReleaseGroup[] }>(
      '/release-group',
      { query: q, limit: String(limit) },
      TTL.search,
    );
    return (data['release-groups'] ?? []).map((rg) => this.mapReleaseGroup(rg));
  }

  async searchRecordings(q: string, limit = 15): Promise<MbRecordingResult[]> {
    const data = await this.cached<{ recordings?: RawRecording[] }>(
      '/recording',
      { query: q, limit: String(limit) },
      TTL.search,
    );
    return (data.recordings ?? []).map((r) => this.mapRecording(r));
  }

  // ---- lookups ----

  async lookupArtist(mbid: string): Promise<MbArtistResult> {
    const a = await this.cached<RawArtist>(`/artist/${mbid}`, {}, TTL.lookup);
    return {
      mbid: a.id,
      name: a.name,
      disambiguation: a.disambiguation || null,
      country: a.country ?? null,
      type: a.type ?? null,
      score: 100,
    };
  }

  async lookupReleaseGroup(mbid: string): Promise<MbReleaseGroupResult> {
    const rg = await this.cached<RawReleaseGroup>(`/release-group/${mbid}`, { inc: 'artists' }, TTL.lookup);
    return this.mapReleaseGroup(rg, 100);
  }

  async lookupRecording(mbid: string): Promise<MbRecordingResult> {
    const rec = await this.cached<RawRecording>(
      `/recording/${mbid}`,
      { inc: 'artists releases release-groups' },
      TTL.lookup,
    );
    return this.mapRecording(rec, 100);
  }

  /** All release groups for an artist (paginated browse; capped at 300). */
  async artistReleaseGroups(artistMbid: string): Promise<MbReleaseGroupResult[]> {
    const out: MbReleaseGroupResult[] = [];
    for (let offset = 0; offset < 300; offset += 100) {
      const data = await this.cached<{ 'release-groups'?: RawReleaseGroup[]; 'release-group-count'?: number }>(
        '/release-group',
        { artist: artistMbid, limit: '100', offset: String(offset) },
        TTL.browse,
      );
      const page = data['release-groups'] ?? [];
      out.push(...page.map((rg) => this.mapReleaseGroup(rg, 100)));
      if (out.length >= (data['release-group-count'] ?? 0) || page.length === 0) break;
    }
    return out;
  }

  /**
   * Full tracklist for a release group, using its most canonical release
   * (official, dated, CD/digital, fewest media). Drives the acquisition pipeline.
   */
  async releaseGroupTracklist(rgMbid: string): Promise<MbTracklist> {
    const rg = await this.cached<RawReleaseGroup & { releases?: RawReleaseRef[] }>(
      `/release-group/${rgMbid}`,
      { inc: 'artists releases media' },
      TTL.lookup,
    );
    const releases = rg.releases ?? [];
    if (!releases.length) throw new MusicBrainzError(404, `Release group ${rgMbid} has no releases`);
    const releaseScore = (r: RawReleaseRef): number => {
      let s = 0;
      if (r.status === 'Official') s += 100;
      if (r.date) s += 10;
      if (r.country && ['XW', 'US', 'GB'].includes(r.country)) s += 5;
      const formats = (r.media ?? []).map((m) => m.format ?? '');
      if (formats.some((f) => f === 'CD' || f === 'Digital Media')) s += 5;
      s -= (r.media?.length ?? 1) - 1; // prefer fewer discs
      return s;
    };
    const best = [...releases].sort((a, b) => releaseScore(b) - releaseScore(a))[0]!;
    const rel = await this.cached<RawReleaseFull>(
      `/release/${best.id}`,
      { inc: 'recordings artist-credits media' },
      TTL.lookup,
    );
    const artistName = creditName(rg['artist-credit']);
    const artistMbid = rg['artist-credit']?.[0]?.artist?.id ?? null;
    const media = rel.media ?? [];
    const tracks = media.flatMap((m, mi) =>
      (m.tracks ?? []).map((t, ti) => ({
        disc: m.position ?? mi + 1,
        position: t.position ?? ti + 1,
        title: t.title ?? t.recording?.title ?? 'Unknown',
        artistName: t['artist-credit']?.length ? creditName(t['artist-credit']) : artistName,
        recordingMbid: t.recording?.id ?? '',
        durationMs: t.length ?? t.recording?.length ?? null,
      })),
    );
    if (!tracks.length) throw new MusicBrainzError(404, `Release ${best.id} has no tracks`);
    return {
      releaseMbid: rel.id,
      releaseGroupMbid: rg.id,
      title: rg.title,
      artistName,
      artistMbid,
      isVariousArtists: artistMbid === '89ad4ac3-39f7-470e-963a-56509c546377',
      year: yearOf(rg['first-release-date']) ?? yearOf(rel.date),
      discCount: media.length || 1,
      tracks,
    };
  }

  // ---- mapping ----

  private mapReleaseGroup(rg: RawReleaseGroup, defaultScore = 0): MbReleaseGroupResult {
    return {
      mbid: rg.id,
      title: rg.title,
      artistName: creditName(rg['artist-credit']),
      artistMbid: rg['artist-credit']?.[0]?.artist?.id ?? null,
      year: yearOf(rg['first-release-date']),
      primaryType: rg['primary-type'] ?? null,
      secondaryTypes: rg['secondary-types'] ?? [],
      coverUrl: caaCoverUrl(rg.id),
      score: rg.score ?? defaultScore,
      inLibrary: false,
      requested: false,
    };
  }

  private mapRecording(rec: RawRecording, defaultScore = 0): MbRecordingResult {
    const releases = rec.releases ?? [];
    const best =
      releases.find(
        (r) =>
          r['release-group']?.['primary-type'] === 'Album' &&
          !(r['release-group']?.['secondary-types'] ?? []).length,
      ) ??
      releases.find((r) => r['release-group']) ??
      releases[0];
    const rgId = best?.['release-group']?.id ?? null;
    return {
      mbid: rec.id,
      title: rec.title,
      artistName: creditName(rec['artist-credit']),
      artistMbid: rec['artist-credit']?.[0]?.artist?.id ?? null,
      releaseGroupMbid: rgId,
      releaseTitle: best?.['release-group']?.title ?? best?.title ?? null,
      durationMs: rec.length ?? null,
      coverUrl: rgId ? caaCoverUrl(rgId) : null,
      score: rec.score ?? defaultScore,
      inLibrary: false,
      requested: false,
    };
  }
}
