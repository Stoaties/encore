/**
 * Encore build version — bumped per release. The server serves this via
 * /api/app-version; the Capacitor Android app compares it against its own
 * bundled copy to detect that a newer server has been deployed and the
 * installed APK is stale.
 */
export const APP_VERSION = '0.4.1';

// ---------- auth ----------
export interface LoginRequest {
  username: string;
  password: string;
}
export interface AppUser {
  id: string;
  username: string;
  isAdmin: boolean;
}
export interface JellyfinSession {
  baseUrl: string;
  token: string;
  userId: string;
  deviceId: string;
}
export interface SessionInfo {
  token: string;
  user: AppUser;
  jellyfin: JellyfinSession;
}

// ---------- library ----------
export interface ArtistSummary {
  id: string;
  name: string;
  imageTag?: string | null;
}
export interface AlbumSummary {
  id: string;
  name: string;
  albumArtist: string;
  artistId?: string | null;
  year?: number | null;
  imageTag?: string | null;
  trackCount?: number | null;
  runtimeSec?: number | null;
  isFavorite?: boolean;
  /** MusicBrainz release-group id from Jellyfin's ProviderIds — used to match against Encore requests for refetch */
  mbReleaseGroupId?: string | null;
}
export interface TrackSummary {
  id: string;
  name: string;
  album?: string | null;
  albumId?: string | null;
  artists: string[];
  albumArtist?: string | null;
  artistId?: string | null;
  durationSec: number;
  trackNumber?: number | null;
  discNumber?: number | null;
  /** item whose Primary image to show (usually the album) */
  imageItemId?: string | null;
  imageTag?: string | null;
  isFavorite: boolean;
  /** entry id within a playlist (needed to remove the track from it) */
  playlistEntryId?: string | null;
  /** MusicBrainz recording id from Jellyfin's ProviderIds — used to match against Encore requests for refetch */
  mbRecordingId?: string | null;
  /** MusicBrainz release-group id from Jellyfin's ProviderIds — lets a track fall back to its parent album's request for refetch */
  mbReleaseGroupId?: string | null;
}
export interface ArtistDetail {
  artist: ArtistSummary;
  albums: AlbumSummary[];
}
export interface AlbumDetail {
  album: AlbumSummary;
  tracks: TrackSummary[];
}
export interface SearchResults {
  artists: ArtistSummary[];
  albums: AlbumSummary[];
  tracks: TrackSummary[];
}
export interface HomeData {
  recentlyAdded: AlbumSummary[];
  random: AlbumSummary[];
}
export interface Paged<T> {
  items: T[];
  total: number;
  start: number;
}

// ---------- playlists ----------
export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount?: number | null;
  imageTag?: string | null;
  /** true when visible to all Encore users via Jellyfin's OpenAccess.
      absent (undefined) when the API doesn't attach it (e.g. server didn't fetch the field). */
  isPublic?: boolean;
  /** owner's Encore user id; null when not owned by the requesting user's Jellyfin session */
  isOwner?: boolean;
}
export interface PlaylistDetail {
  playlist: PlaylistSummary;
  tracks: TrackSummary[];
  /** current active share for this playlist owned by the requesting user (null if none) */
  share?: PlaylistShare | null;
}
export interface PlaylistShare {
  token: string;
  /** absolute URL you can copy into a message — includes the app origin */
  url: string;
  createdAt: string;
}
/** Public payload served at /api/public/playlists/:token — no auth required. */
export interface SharedPlaylistView {
  id: string;
  name: string;
  ownerName: string;
  tracks: SharedTrack[];
  imageUrl?: string | null;
}
export interface SharedTrack {
  /** opaque per-share track id — feeds into /api/public/playlists/:token/audio/:id */
  id: string;
  name: string;
  artists: string[];
  album?: string | null;
  durationSec: number;
  audioUrl: string;
  imageUrl?: string | null;
}

// ---------- requests ----------
export type RequestType = 'track' | 'album' | 'artist';
export type RequestStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'searching'
  | 'downloading'
  | 'processing'
  | 'available'
  | 'failed';

export interface MusicRequest {
  id: string;
  type: RequestType;
  status: RequestStatus;
  artistName: string;
  albumTitle?: string | null;
  trackTitle?: string | null;
  mbArtistId?: string | null;
  mbReleaseGroupId?: string | null;
  mbRecordingId?: string | null;
  coverUrl?: string | null;
  year?: number | null;
  requestedBy: { id: string; username: string };
  parentId?: string | null;
  errorMessage?: string | null;
  /** 0-100 while downloading */
  progress?: number | null;
  createdAt: string;
  updatedAt: string;
  children?: MusicRequest[];
}
export interface CreateRequestBody {
  type: RequestType;
  /** artist => artist mbid, album => release-group mbid, track => recording mbid */
  mbid: string;
}

// ---------- musicbrainz discovery ----------
export interface MbArtistResult {
  mbid: string;
  name: string;
  disambiguation?: string | null;
  country?: string | null;
  type?: string | null;
  score: number;
}
export interface MbReleaseGroupResult {
  mbid: string;
  title: string;
  artistName: string;
  artistMbid?: string | null;
  year?: number | null;
  primaryType?: string | null;
  secondaryTypes: string[];
  coverUrl: string;
  score: number;
  inLibrary: boolean;
  requested: boolean;
}
export interface MbRecordingResult {
  mbid: string;
  title: string;
  artistName: string;
  artistMbid?: string | null;
  releaseGroupMbid?: string | null;
  releaseTitle?: string | null;
  durationMs?: number | null;
  coverUrl?: string | null;
  score: number;
  inLibrary: boolean;
  requested: boolean;
}
export interface MbSearchResults {
  artists: MbArtistResult[];
  releaseGroups: MbReleaseGroupResult[];
  recordings: MbRecordingResult[];
}
export interface MbArtistDetail {
  artist: MbArtistResult;
  releaseGroups: MbReleaseGroupResult[];
}

// ---------- musicbrainz release tracklist (acquisition) ----------
export interface MbTrack {
  disc: number;
  position: number;
  title: string;
  artistName: string;
  recordingMbid: string;
  durationMs?: number | null;
}
export interface MbTracklist {
  releaseMbid: string;
  releaseGroupMbid: string;
  title: string;
  artistName: string;
  artistMbid?: string | null;
  isVariousArtists: boolean;
  year?: number | null;
  discCount: number;
  tracks: MbTrack[];
}

// ---------- settings ----------
export interface AppSettings {
  autoApprove: { admins: boolean; users: boolean };
  /** requests per user per day; 0 = unlimited */
  quotaPerUserPerDay: number;
  quality: {
    /** in preference order, e.g. ["flac", "mp3"] */
    preferredFormats: string[];
    minBitrateKbps: number;
  };
  shuffle: {
    favoriteBoost: number;
    skipPenalty: number;
    recencyHours: number;
    recencyPenalty: number;
    playCountWeight: number;
  };
  acquisition: {
    maxConcurrentDownloads: number;
    searchTimeoutSec: number;
    stallTimeoutMin: number;
    maxRetriesPerRequest: number;
  };
}

// ---------- jobs (admin) ----------
export interface JobSummary {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  requestId?: string | null;
  lastError?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}
export interface JobLogLine {
  ts: string;
  level: string;
  message: string;
}

// ---------- playback tracking / shuffle ----------
export type PlayEvent = 'play' | 'complete' | 'skip';
export interface ReportPlayBody {
  itemId: string;
  event: PlayEvent;
  positionSec?: number;
  durationSec?: number;
}

// ---------- playlist import ----------
export type ImportSource = 'spotify' | 'youtube';
// resolving = fetching source + matching; done = Jellyfin playlist built,
// missing tracks can be requested inline; failed = something upstream broke.
// ('review' / 'requesting' are legacy — kept in the enum for older rows.)
export type ImportStatus = 'resolving' | 'review' | 'requesting' | 'done' | 'failed';
export type MatchStatus = 'auto' | 'needs_review' | 'confirmed' | 'rejected' | 'unmatched';
export interface ImportItem {
  id: string;
  position: number;
  sourceTitle: string;
  sourceArtist?: string | null;
  sourceAlbum?: string | null;
  durationMs?: number | null;
  matchMbRecordingId?: string | null;
  matchTitle?: string | null;
  matchArtist?: string | null;
  matchAlbum?: string | null;
  matchScore?: number | null;
  matchStatus: MatchStatus;
  inLibrary?: boolean;
  requestId?: string | null;
}
export interface ImportBatch {
  id: string;
  source: ImportSource;
  url: string;
  title?: string | null;
  status: ImportStatus;
  error?: string | null;
  items: ImportItem[];
  createdAt: string;
  /** cover image URL captured from the source (Spotify cdn) — displayed in the Encore view */
  coverUrl?: string | null;
  /** Jellyfin playlist id created for the in-library subset, in original order */
  jellyfinPlaylistId?: string | null;
  /** true when the source had more tracks than we could fetch (Spotify embed caps at 100) */
  truncated?: boolean | null;
}

// ---------- server-sent events ----------
export type ServerEvent =
  | { kind: 'request-updated'; request: MusicRequest }
  | { kind: 'job-log'; jobId: string; requestId?: string | null; level: string; message: string; ts: string }
  | { kind: 'import-updated'; batchId: string; status: ImportStatus };

// ---------- matching helpers ----------

/**
 * Normalizes a title/artist name for fuzzy equality: lowercase, strip
 * diacritics, "&" -> "and", collapse all punctuation to single spaces.
 */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Cover Art Archive front-cover URL for a release group (404s when no art exists). */
export function caaCoverUrl(releaseGroupMbid: string, size: 250 | 500 | 1200 = 250): string {
  return `https://coverartarchive.org/release-group/${releaseGroupMbid}/front-${size}`;
}

// ---------- jellyfin client-side url helpers ----------
export function jfImageUrl(
  jf: Pick<JellyfinSession, 'baseUrl' | 'token'>,
  itemId: string,
  opts: { tag?: string | null; size?: number } = {},
): string {
  const p = new URLSearchParams();
  p.set('fillHeight', String(opts.size ?? 300));
  p.set('fillWidth', String(opts.size ?? 300));
  p.set('quality', '90');
  if (opts.tag) p.set('tag', opts.tag);
  p.set('api_key', jf.token);
  return `${jf.baseUrl}/Items/${itemId}/Images/Primary?${p.toString()}`;
}

/**
 * Direct-from-Jellyfin stream URL. Direct-plays common containers; falls back to
 * a progressive mp3 transcode (plain HTTP, playable in every <audio> element).
 */
export function jfAudioUrl(jf: JellyfinSession, itemId: string, maxStreamingBitrate = 320000000): string {
  const p = new URLSearchParams({
    userId: jf.userId,
    deviceId: jf.deviceId,
    api_key: jf.token,
    container: 'opus,webm|opus,mp3,aac,m4a|aac,m4b|aac,flac,webma,webm|webma,wav,ogg',
    transcodingContainer: 'mp3',
    transcodingProtocol: 'http',
    audioCodec: 'mp3',
    maxStreamingBitrate: String(maxStreamingBitrate),
    startTimeTicks: '0',
    enableRedirection: 'true',
  });
  return `${jf.baseUrl}/Audio/${itemId}/universal?${p.toString()}`;
}
