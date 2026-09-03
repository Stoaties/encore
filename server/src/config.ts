import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string(),
  JELLYFIN_URL: z.string(),
  JELLYFIN_PUBLIC_URL: z.string().optional(),
  JELLYFIN_API_KEY: z.string().optional(),
  JWT_SECRET: z.string().min(8),
  MUSIC_LIBRARY_PATH: z.string(),
  STAGING_PATH: z.string(),
  SLSKD_URL: z.string().default('http://localhost:5030'),
  SLSKD_API_KEY: z.string().default(''),
  SLSKD_DOWNLOADS_PATH: z.string().optional(),
  MUSICBRAINZ_USER_AGENT: z.string().default('Encore/0.1.0 (self-hosted)'),
  YOUTUBE_API_KEY: z.string().optional(),
  YOUTUBE_API_URL: z.string().default('https://www.googleapis.com/youtube/v3'),
  // Spotify import is proxied through spotdl-web (no Spotify dev API needed);
  // point this at the in-cluster URL (default) or override for local dev
  SPOTDL_WEB_URL: z.string().default('http://spotdl-web.media.svc.cluster.local'),
  PORT: z.coerce.number().default(8080),
  WEB_DIST: z.string().optional(),
  NODE_ENV: z.string().default('development'),
});

export type Config = ReturnType<typeof loadConfig>;

const stripSlash = (u: string) => u.replace(/\/+$/, '');

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Env.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    jellyfinUrl: stripSlash(e.JELLYFIN_URL),
    jellyfinPublicUrl: stripSlash(e.JELLYFIN_PUBLIC_URL || e.JELLYFIN_URL),
    jellyfinApiKey: e.JELLYFIN_API_KEY,
    jwtSecret: e.JWT_SECRET,
    musicLibraryPath: e.MUSIC_LIBRARY_PATH,
    stagingPath: e.STAGING_PATH,
    slskdUrl: stripSlash(e.SLSKD_URL),
    slskdApiKey: e.SLSKD_API_KEY,
    slskdDownloadsPath: e.SLSKD_DOWNLOADS_PATH,
    musicbrainzUserAgent: e.MUSICBRAINZ_USER_AGENT,
    youtubeApiKey: e.YOUTUBE_API_KEY,
    youtubeApiUrl: stripSlash(e.YOUTUBE_API_URL),
    spotdlWebUrl: stripSlash(e.SPOTDL_WEB_URL),
    port: e.PORT,
    webDist: e.WEB_DIST,
    isProd: e.NODE_ENV === 'production',
  };
}
