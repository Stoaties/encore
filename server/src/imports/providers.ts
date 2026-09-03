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
    const m = /^\/(?:intl-[a-z]+\/)?playlist\/([A-Za-z0-9]+)/.exec(u.pathname);
    if (m) return { source: 'spotify', id: m[1]! };
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const list = u.searchParams.get('list');
    if (list) return { source: 'youtube', id: list };
  }
  return null;
}

// ---------- spotify (via spotdl-web sidecar; no Spotify dev API required) ----------
//
// We proxy the enumeration through the sibling spotdl-web service instead of
// hitting api.spotify.com ourselves. spotdl handles auth internally (with
// bundled credentials), pagination, and every URL shape (playlist/album/track/
// artist) that spotdl-web already accepts — so Encore no longer needs its own
// Spotify Developer app.
export async function fetchSpotifyPlaylist(
  config: Config,
  playlistId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SourcePlaylist> {
  const url = `https://open.spotify.com/playlist/${playlistId}`;
  const res = await fetchImpl(`${config.spotdlWebUrl}/api/enumerate?url=${encodeURIComponent(url)}`);
  if (res.status === 400) throw new ImportProviderError(400, 'Invalid Spotify playlist URL');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // spotdl-web returns spotdl's stderr on 502 — surface a hint if it's the
    // usual "playlist is private / does not exist" case
    if (/not found|does not exist|invalid/i.test(body))
      throw new ImportProviderError(404, 'Spotify playlist not found (is it public?)');
    throw new ImportProviderError(502, `spotdl-web enumeration failed (${res.status})`);
  }
  const data = (await res.json()) as { title?: string; tracks?: SourceTrack[] };
  return { title: data.title ?? 'Spotify playlist', tracks: data.tracks ?? [] };
}

// ---------- youtube (Data API v3) ----------

interface YtPlaylistItem {
  snippet?: {
    title?: string;
    videoOwnerChannelTitle?: string;
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
  const metaRes = await fetchImpl(`${config.youtubeApiUrl}/playlists?part=snippet&id=${playlistId}&${key}`);
  if (!metaRes.ok) throw new ImportProviderError(502, `YouTube playlist lookup failed (${metaRes.status})`);
  const meta = (await metaRes.json()) as { items?: { snippet?: { title?: string } }[] };
  const title = meta.items?.[0]?.snippet?.title;
  if (!title) throw new ImportProviderError(404, 'YouTube playlist not found (is it public?)');

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
  return { title, tracks };
}

export function fetchPlaylist(
  config: Config,
  source: ImportSource,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SourcePlaylist> {
  return source === 'spotify'
    ? fetchSpotifyPlaylist(config, id, fetchImpl)
    : fetchYoutubePlaylist(config, id, fetchImpl);
}
