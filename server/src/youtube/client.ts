import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * yt-dlp + ffmpeg wrapper for the "grab this track from YouTube" fallback path.
 *
 * The image installs `yt-dlp` and `ffmpeg` via apk (see Dockerfile). We shell
 * out rather than binding a node library to keep the runtime image small and
 * to get yt-dlp's steady flow of updates by just bumping the apk package.
 */

export class YoutubeError extends Error {}
export class YoutubeNotFoundError extends YoutubeError {}

export interface YoutubeSearchResult {
  /** Path to the downloaded audio file (mp3). */
  filePath: string;
  /** Video id we downloaded from — surfaced in logs so admins can audit. */
  videoId: string;
  /** Video title yt-dlp reported. */
  videoTitle: string;
  /** Approximate duration in seconds (from yt-dlp metadata). */
  durationSec: number | null;
}

export interface YoutubeClientOpts {
  /** Working directory yt-dlp writes into. */
  stagingDir: string;
  /** Optional per-run timeout, defaults to 10 minutes. */
  timeoutMs?: number;
  /** Log hook — swallowed if omitted. */
  log?: (msg: string) => void;
}

/**
 * Downloads the top audio result on YouTube for `query`, extracts to mp3 320k,
 * and returns its path. Throws YoutubeNotFoundError if the search yields zero
 * results (rare — YouTube is usually generous), or YoutubeError for any other
 * failure. Caller is responsible for cleaning up stagingDir.
 */
export async function downloadTopMatch(query: string, opts: YoutubeClientOpts): Promise<YoutubeSearchResult> {
  const { stagingDir, timeoutMs = 600_000, log } = opts;
  await fs.mkdir(stagingDir, { recursive: true });

  // ytsearch1: returns the single best hit. Match Type=Music at the front to bias
  // away from lyric videos / covers when the query is generic (e.g. "Mikado").
  // Filter out obvious non-song results (shorts, live streams, mixes).
  const search = `ytsearch1:${query}`;
  const outTemplate = path.join(stagingDir, '%(id)s.%(ext)s');

  const args = [
    '--no-progress',
    '--no-warnings',
    '--no-playlist',
    '--match-filter', '!is_live & duration < 900 & duration > 30',
    '-f', 'bestaudio/best',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0', // maps to 320k in ffmpeg
    // No --embed-thumbnail: MB tagging + cover embed happens post-download in
    // the acquisition worker via the shared writeTags helper. Keeps the
    // runtime image smaller (no atomicparsley dependency).
    '--print-json',
    '-o', outTemplate,
    search,
  ];
  log?.(`yt-dlp ${args.join(' ')}`);

  const { stdout, stderr, code } = await run('yt-dlp', args, timeoutMs);
  if (code !== 0) {
    if (/no results/i.test(stderr) || /no such video/i.test(stderr)) {
      throw new YoutubeNotFoundError(`YouTube search returned no matches for "${query}"`);
    }
    throw new YoutubeError(`yt-dlp exited ${code}: ${stderr.slice(-500).trim() || 'no stderr'}`);
  }

  // yt-dlp prints one JSON blob per downloaded video with --print-json
  const line = stdout.trim().split('\n').find((l) => l.startsWith('{'));
  if (!line) throw new YoutubeError('yt-dlp completed but produced no metadata');
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(line);
  } catch (err) {
    throw new YoutubeError(`Could not parse yt-dlp metadata: ${(err as Error).message}`);
  }
  const videoId = String(meta.id ?? '');
  const videoTitle = String(meta.title ?? '');
  const durationSec = typeof meta.duration === 'number' ? meta.duration : null;
  if (!videoId) throw new YoutubeError('yt-dlp metadata missing video id');

  // With `-x --audio-format mp3` yt-dlp writes <stagingDir>/<id>.mp3.
  const filePath = path.join(stagingDir, `${videoId}.mp3`);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) throw new YoutubeError(`Expected output ${filePath} not found after yt-dlp run`);

  return { filePath, videoId, videoTitle, durationSec };
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new YoutubeError(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.message.includes('ENOENT') ? new YoutubeError(`${cmd} not installed in the container`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
