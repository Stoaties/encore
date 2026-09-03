import type { ImportSource } from '@encore/shared';
import type { Config } from '../config.js';

export interface SourceTrack {
  title: string;
  artist?: string | null;
  album?: string | null;
  durationMs?: number | null;
}
export interface SourcePlaylist {
  title: string;
  tracks: SourceTrack[];
  /** cover image URL from the source (Spotify cdn / YouTube thumbnail) */
  coverUrl?: string | null;
  /** true when the source had more tracks than we could fetch (Spotify embed caps at 100) */
  truncated?: boolean;
}

export class ImportProviderError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ImportProviderError';
  }
}

export function parsePlaylistUrl(url: string): { source: ImportSource; id: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'open.spotify.com') {
    // /playlist/, /album/, /track/ — all fetchable via /embed/{kind}/{id}
    const m = /^\/(?:intl-[a-z]+\/)?(playlist|album|track)\/([A-Za-z0-9]+)/.exec(u.pathname);
    if (m) return { source: 'spotify', id: `${m[1]}:${m[2]}` };
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const list = u.searchParams.get('list');
    if (list) return { source: 'youtube', id: list };
  }
  return null;
}

// ---------- spotify (public embed page, no Developer API) ----------
//
// The open.spotify.com "internal" endpoints (get_access_token, /pathfinder graphql)
// started returning 403 URL Blocked in 2026, so this reads the same JSON blob the
// public /embed/{kind}/{id} page ships to browsers in a __NEXT_DATA__ <script>.
// Works unauthenticated for public playlists/albums/tracks. Caps at 100 tracks per
// playlist — full pagination needs the graphql endpoint which now requires a
// Spotify Developer app (per the user's constraint, not going that route).

interface EmbedTrackRaw {
  uri?: string;
  title?: string;
  subtitle?: string; // "Artist" or "Artist, Artist" — a plain string
  duration?: number; // ms
}
interface EmbedEntityRaw {
  type?: string;
  name?: string;
  coverArt?: { sources?: { url?: string; width?: number | null }[] };
  visualIdentity?: { image?: { url?: string; maxReleaseYear?: number }[] };
  trackList?: EmbedTrackRaw[];
  // /embed/track has these instead of a trackList
  duration?: number;
  artists?: { name?: string }[];
  album?: { name?: string };
}

async function fetchSpotifyEmbedEntity(
  kind: string,
  id: string,
  fetchImpl: typeof fetch,
): Promise<EmbedEntityRaw> {
  const url = `https://open.spotify.com/embed/${kind}/${id}`;
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (res.status === 404) {
    throw new ImportProviderError(404, 'Spotify item not found (is it public?)');
  }
  if (!res.ok) {
    throw new ImportProviderError(502, `Spotify embed fetch failed (${res.status})`);
  }
  const html = await res.text();
  const m = /__NEXT_DATA__"\s+type="application\/json">([\s\S]+?)<\/script>/.exec(html);
  if (!m) {
    throw new ImportProviderError(502, 'Spotify embed page has no data blob — layout may have changed');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]!);
  } catch (err) {
    throw new ImportProviderError(502, `Spotify embed JSON parse failed: ${(err as Error).message}`);
  }
  const entity = (parsed as { props?: { pageProps?: { state?: { data?: { entity?: EmbedEntityRaw } } } } })?.props
    ?.pageProps?.state?.data?.entity;
  if (!entity) throw new ImportProviderError(502, 'Spotify embed JSON missing entity');
  return entity;
}

function pickLargestCover(entity: EmbedEntityRaw): string | null {
  const covers: { url?: string; width?: number | null }[] =
    entity.coverArt?.sources ?? entity.visualIdentity?.image ?? [];
  const withUrl = covers.filter((c) => c.url);
  if (!withUrl.length) return null;
  // sources typically ship sorted small→large; grab the widest we can see
  return withUrl.reduce((best, c) => ((c.width ?? 0) >= (best.width ?? 0) ? c : best), withUrl[0]!).url ?? null;
}

export async function fetchSpotifyEntity(
  playlistIdKind: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SourcePlaylist> {
  // playlistIdKind is "playlist:<id>", "album:<id>", or "track:<id>" (see parsePlaylistUrl)
  const [kind, id] = playlistIdKind.split(':');
  if (!kind || !id) throw new ImportProviderError(400, 'Invalid Spotify URL');
  const entity = await fetchSpotifyEmbedEntity(kind, id, fetchImpl);
  const coverUrl = pickLargestCover(entity);
  const title = entity.name ?? `Spotify ${kind}`;

  if (kind === 'track') {
    const t: SourceTrack = {
      title: entity.name ?? 'Unknown track',
      artist: (entity.artists ?? []).map((a) => a.name ?? '').filter(Boolean).join(', ') || null,
      album: entity.album?.name ?? null,
      durationMs: entity.duration ?? null,
    };
    return { title, tracks: [t], coverUrl };
  }

  const raw = entity.trackList ?? [];
  const tracks: SourceTrack[] = raw
    .filter((t) => t.title)
    .map((t) => ({
      title: t.title!,
      artist: t.subtitle ?? null,
      album: null, // embed doesn't carry per-track album info
      durationMs: t.duration ?? null,
    }));
  // The embed page ships at most 100 items even for larger playlists — flag it
  // so we can surface a warning in the UI. There's no reliable public track-count
  // field, but ≥100 is a strong hint we hit the cap.
  const truncated = tracks.length >= 100;
  return { title, tracks, coverUrl, truncated };
}

// ---------- youtube (Data API v3) ----------

interface YtPlaylistItem {
  snippet?: {
    title?: string;
    videoOwnerChannelTitle?: string;
    thumbnails?: { high?: { url?: string }; standard?: { url?: string }; maxres?: { url?: string } };
  };
}

/**
 * Video titles are messy ("Artist - Song (Official Video) [4K]"). Strip the
 * noise, split on the first dash, and fall back to the channel name (minus
 * YT Music's " - Topic" suffix) for the artist.
 */
export function parseYtTitle(videoTitle: string, channelTitle?: string | null): SourceTrack | null {
  if (/^(deleted video|private video)$/i.test(videoTitle.trim())) return null;
  let t = videoTitle
    .replace(/[([][^)\]]*(official|video|audio|lyric|lyrics|visuali[sz]er|remaster(ed)?|hd|4k|hq|mv|m\/v)[^)\]]*[)\]]/gi, ' ')
    .replace(/\s*(official\s+(music\s+)?video|official\s+audio|lyrics?\s+video)\s*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let artist: string | null = null;
  const dash = /\s[-–—]\s/.exec(t);
  if (dash) {
    artist = t.slice(0, dash.index).trim();
    t = t.slice(dash.index + dash[0].length).trim();
  } else if (channelTitle) {
    artist = channelTitle.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim() || null;
  }
  t = t.replace(/^"(.+)"$/, '$1').trim();
  if (!t) return null;
  return { title: t, artist };
}

export async function fetchYoutubePlaylist(
  config: Config,
  playlistId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SourcePlaylist> {
  if (!config.youtubeApiKey) {
    throw new ImportProviderError(400, 'YouTube import requires YOUTUBE_API_KEY');
  }
  const key = `key=${encodeURIComponent(config.youtubeApiKey)}`;
  const metaRes = await fetchImpl(
    `${config.youtubeApiUrl}/playlists?part=snippet&id=${playlistId}&${key}`,
  );
  if (!metaRes.ok) throw new ImportProviderError(502, `YouTube playlist lookup failed (${metaRes.status})`);
  type YtThumbs = NonNullable<NonNullable<YtPlaylistItem['snippet']>['thumbnails']>;
  const meta = (await metaRes.json()) as {
    items?: { snippet?: { title?: string; thumbnails?: YtThumbs } }[];
  };
  const snippet = meta.items?.[0]?.snippet;
  const title = snippet?.title;
  if (!title) throw new ImportProviderError(404, 'YouTube playlist not found (is it public?)');
  const th = snippet.thumbnails;
  const coverUrl = th?.maxres?.url ?? th?.standard?.url ?? th?.high?.url ?? null;

  const tracks: SourceTrack[] = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const res = await fetchImpl(
      `${config.youtubeApiUrl}/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}&${key}`,
    );
    if (!res.ok) throw new ImportProviderError(502, `YouTube playlist items failed (${res.status})`);
    const data = (await res.json()) as { items?: YtPlaylistItem[]; nextPageToken?: string };
    for (const item of data.items ?? []) {
      const parsed = parseYtTitle(item.snippet?.title ?? '', item.snippet?.videoOwnerChannelTitle);
      if (parsed) tracks.push(parsed);
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return { title, tracks, coverUrl };
}

export function fetchPlaylist(
  config: Config,
  source: ImportSource,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SourcePlaylist> {
  return source === 'spotify' ? fetchSpotifyEntity(id, fetchImpl) : fetchYoutubePlaylist(config, id, fetchImpl);
}
