import fs from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { MbTracklist, RequestStatus } from '@encore/shared';
import { normalizeForMatch } from '@encore/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { EventBus } from '../events.js';
import type { JellyfinClient } from '../jellyfin/client.js';
import type { MusicBrainzClient } from '../musicbrainz/client.js';
import type { SlskdClient, SlskdSearchFile, SlskdTransfer } from '../slskd/client.js';
import { getSettings } from '../settings/service.js';
import { publishUpdated } from '../requests/service.js';
import type { ImportJobHandler } from '../imports/service.js';
import { ImportProviderError } from '../imports/providers.js';
import {
  scoreAlbumCandidates,
  scoreTrackCandidates,
  baseOf,
  dirOf,
  extOf,
  type AlbumCandidate,
  type TrackCandidate,
} from './scoring.js';
import { albumDirParts, sanitizePathPart, trackFileName } from './naming.js';
import { fetchCover, verifyAudio, writeTags, AudioVerifyError } from './tagging.js';

/** Unrecoverable for this request — do not retry the job. */
export class PermanentError extends Error {}
/** The request row disappeared (deleted by an admin) — abort quietly. */
class RequestGoneError extends Error {}

type JobRow = typeof schema.jobs.$inferSelect;
type RequestRow = typeof schema.requests.$inferSelect;
type Jlog = (level: 'info' | 'warn' | 'error', message: string) => Promise<void>;

/** Persisted in request.meta so a refetch can skip the same wrong slskd hit next time. */
export type BlocklistedSource =
  | { username: string; directory: string; filename?: undefined }
  | { username: string; filename: string; directory?: undefined };

type Target =
  | { kind: 'album'; tracklist: MbTracklist }
  | {
      kind: 'track';
      title: string;
      artistName: string;
      durationMs?: number | null;
      releaseTitle?: string | null;
      releaseGroupMbid?: string | null;
      artistMbid?: string | null;
      recordingMbid: string;
    };

export interface WorkerDeps {
  db: Db;
  config: Config;
  jellyfin: JellyfinClient;
  mb: MusicBrainzClient;
  slskd: SlskdClient;
  events: EventBus;
  /** handles 'import-resolve' jobs (playlist imports share the acquisition queue) */
  imports?: ImportJobHandler;
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  /** how often to look for new jobs */
  pollIntervalMs?: number;
  /** how often to poll slskd transfer progress */
  transferPollMs?: number;
  /** how long to wait for Jellyfin to index new files */
  indexTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TERMINAL: RequestStatus[] = ['available', 'failed', 'denied'];

export class AcquisitionWorker {
  private timer?: NodeJS.Timeout;
  private active = 0;
  private stopped = true;
  private pollIntervalMs: number;
  private transferPollMs: number;
  private indexTimeoutMs: number;

  constructor(private deps: WorkerDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
    this.transferPollMs = deps.transferPollMs ?? 1500;
    this.indexTimeoutMs = deps.indexTimeoutMs ?? 120_000;
  }

  async start(): Promise<void> {
    // recover jobs orphaned by a crash/restart — the pipeline is restartable from scratch
    await this.deps.db
      .update(schema.jobs)
      .set({ status: 'pending', runAt: new Date() })
      .where(eq(schema.jobs.status, 'running'));
    this.stopped = false;
    void this.loop();
    this.deps.log.info('acquisition worker started');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private loop = async (): Promise<void> => {
    if (this.stopped) return;
    try {
      await this.tick();
    } catch (err) {
      this.deps.log.error(`acquisition tick failed: ${(err as Error).message}`);
    }
    this.timer = setTimeout(() => void this.loop(), this.pollIntervalMs);
  };

  private async tick(): Promise<void> {
    const limit = (await getSettings(this.deps.db)).acquisition.maxConcurrentDownloads;
    while (this.active < limit && !this.stopped) {
      const job = await this.claim();
      if (!job) return;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
      });
    }
  }

  private async claim(): Promise<JobRow | null> {
    const res = await this.deps.db.execute(sql`
      update jobs set status = 'running', started_at = now(), attempts = attempts + 1
      where id = (
        select id from jobs
        where status = 'pending' and type in ('acquire-request', 'import-resolve') and run_at <= now()
        order by priority desc, created_at asc
        for update skip locked
        limit 1
      )
      returning id, type, payload, attempts, max_attempts as "maxAttempts", request_id as "requestId"
    `);
    const row = (res.rows ?? [])[0] as
      | { id: string; type: string; payload: unknown; attempts: number; maxAttempts: number; requestId: string | null }
      | undefined;
    return row ? ({ ...row } as JobRow) : null;
  }

  private async run(job: JobRow): Promise<void> {
    const jlog: Jlog = async (level, message) => {
      await this.deps.db.insert(schema.jobLogs).values({ jobId: job.id, level, message }).catch(() => {});
      this.deps.events.publish({
        kind: 'job-log',
        jobId: job.id,
        requestId: job.requestId,
        level,
        message,
        ts: new Date().toISOString(),
      });
    };

    const batchId =
      job.type === 'import-resolve' ? ((job.payload as { batchId?: string } | null)?.batchId ?? null) : null;

    try {
      if (job.type === 'import-resolve') {
        if (!batchId) throw new PermanentError('import job has no batchId');
        if (!this.deps.imports) throw new PermanentError('no import handler configured');
        await this.deps.imports.resolve(batchId, jlog);
      } else {
        if (!job.requestId) throw new PermanentError('job has no request');
        await this.pipeline(job.requestId, jlog);
      }
      await this.deps.db
        .update(schema.jobs)
        .set({ status: 'completed', finishedAt: new Date() })
        .where(eq(schema.jobs.id, job.id));
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof RequestGoneError) {
        await jlog('warn', 'Request was deleted — aborting');
        await this.deps.db
          .update(schema.jobs)
          .set({ status: 'cancelled', finishedAt: new Date(), lastError: 'request deleted' })
          .where(eq(schema.jobs.id, job.id));
        return;
      }
      const permanent =
        err instanceof PermanentError ||
        (err instanceof ImportProviderError && err.statusCode < 500) || // bad URL / not found — retrying won't help
        job.attempts >= job.maxAttempts;
      await jlog('error', msg);
      if (permanent) {
        await this.deps.db
          .update(schema.jobs)
          .set({ status: 'failed', finishedAt: new Date(), lastError: msg })
          .where(eq(schema.jobs.id, job.id));
        if (batchId) await this.deps.imports?.fail(batchId, msg).catch(() => {});
        else if (job.requestId) await this.failRequest(job.requestId, msg).catch(() => {});
      } else {
        const backoffMs = 30_000 * job.attempts;
        await jlog('info', `Will retry in ${Math.round(backoffMs / 1000)}s (attempt ${job.attempts}/${job.maxAttempts})`);
        await this.deps.db
          .update(schema.jobs)
          .set({ status: 'pending', runAt: new Date(Date.now() + backoffMs), lastError: msg })
          .where(eq(schema.jobs.id, job.id));
        if (job.requestId) await this.setRequest(job.requestId, { status: 'approved', progress: null }).catch(() => {});
      }
    }
  }

  // ---------- request row helpers ----------

  private async getRequest(id: string): Promise<RequestRow> {
    const row = await this.deps.db.query.requests.findFirst({ where: eq(schema.requests.id, id) });
    if (!row) throw new RequestGoneError('request deleted');
    return row;
  }

  private async setRequest(
    id: string,
    patch: Partial<Pick<RequestRow, 'status' | 'progress' | 'errorMessage' | 'availableAt'>>,
  ): Promise<void> {
    const rows = await this.deps.db
      .update(schema.requests)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.requests.id, id))
      .returning({ id: schema.requests.id, parentId: schema.requests.parentId });
    if (!rows.length) throw new RequestGoneError('request deleted');
    const target = rows[0]!.parentId ?? rows[0]!.id;
    await publishUpdated(this.deps, target).catch(() => {});
  }

  /** Records which slskd source satisfied the request so a later refetch can blocklist it. */
  private async recordLastSource(id: string, cand: AlbumCandidate | TrackCandidate): Promise<void> {
    const source =
      'mapping' in cand
        ? { username: cand.username, directory: cand.directory, format: cand.format }
        : { username: cand.username, filename: cand.file.filename, format: cand.format };
    const row = await this.deps.db.query.requests.findFirst({
      where: eq(schema.requests.id, id),
      columns: { meta: true },
    });
    if (!row) return;
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    await this.deps.db
      .update(schema.requests)
      .set({ meta: { ...meta, lastSource: source }, updatedAt: new Date() })
      .where(eq(schema.requests.id, id));
  }

  private async failRequest(id: string, message: string): Promise<void> {
    await this.setRequest(id, { status: 'failed', errorMessage: message.slice(0, 500), progress: null });
    const row = await this.deps.db.query.requests.findFirst({ where: eq(schema.requests.id, id) });
    if (row?.parentId) await this.rollupParent(row.parentId);
  }

  /** Recomputes an artist-discography parent from its children's statuses. */
  private async rollupParent(parentId: string): Promise<void> {
    const children = await this.deps.db.query.requests.findMany({
      where: eq(schema.requests.parentId, parentId),
    });
    if (!children.length) return;
    const done = children.filter((c) => c.status === 'available').length;
    const failed = children.filter((c) => c.status === 'failed').length;
    const allTerminal = children.every((c) => TERMINAL.includes(c.status));
    let patch: Partial<Pick<RequestRow, 'status' | 'progress' | 'errorMessage' | 'availableAt'>>;
    if (allTerminal && failed === 0) {
      patch = { status: 'available', progress: null, availableAt: new Date(), errorMessage: null };
    } else if (allTerminal) {
      patch = { status: 'failed', progress: null, errorMessage: `${failed} of ${children.length} albums failed` };
    } else {
      patch = { status: 'downloading', progress: (done / children.length) * 100 };
    }
    await this.deps.db
      .update(schema.requests)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.requests.id, parentId));
    await publishUpdated(this.deps, parentId).catch(() => {});
  }

  // ---------- the pipeline ----------

  private async pipeline(requestId: string, jlog: Jlog): Promise<void> {
    const { config, mb, slskd } = this.deps;
    if (!config.jellyfinApiKey) throw new PermanentError('JELLYFIN_API_KEY must be configured for acquisition');
    if (!config.slskdDownloadsPath) throw new PermanentError('SLSKD_DOWNLOADS_PATH must be configured for acquisition');

    const req = await this.getRequest(requestId);
    if (['pending', 'denied', 'available'].includes(req.status)) {
      await jlog('info', `Request is ${req.status} — nothing to do`);
      return;
    }
    const settings = await getSettings(this.deps.db);
    await this.setRequest(req.id, { status: 'searching', progress: null, errorMessage: null });

    const target: Target =
      req.type === 'album'
        ? await (async () => {
            if (!req.mbReleaseGroupId) throw new PermanentError('album request has no release-group MBID');
            const tracklist = await mb.releaseGroupTracklist(req.mbReleaseGroupId);
            return { kind: 'album' as const, tracklist };
          })()
        : await (async () => {
            if (!req.mbRecordingId) throw new PermanentError('track request has no recording MBID');
            const rec = await mb.lookupRecording(req.mbRecordingId);
            return {
              kind: 'track' as const,
              title: rec.title,
              artistName: rec.artistName,
              durationMs: rec.durationMs,
              releaseTitle: rec.releaseTitle,
              releaseGroupMbid: rec.releaseGroupMbid,
              artistMbid: rec.artistMbid,
              recordingMbid: rec.mbid,
            };
          })();

    if (target.kind === 'album') {
      await jlog(
        'info',
        `Acquiring album “${target.tracklist.title}” by ${target.tracklist.artistName} (${target.tracklist.tracks.length} tracks)`,
      );
    } else {
      await jlog('info', `Acquiring track “${target.title}” by ${target.artistName}`);
    }

    const queries =
      target.kind === 'album'
        ? [`${target.tracklist.artistName} ${target.tracklist.title}`, target.tracklist.title]
        : [`${target.artistName} ${target.title}`];

    const meta = (req.meta ?? {}) as { blocklistedSources?: BlocklistedSource[] };
    const blocklist = meta.blocklistedSources ?? [];
    const isBlocked = (c: AlbumCandidate | TrackCandidate) =>
      blocklist.some((s) =>
        'mapping' in c
          ? s.username === c.username && s.directory === c.directory
          : s.username === c.username && s.filename === c.file.filename,
      );

    let candidates: (AlbumCandidate | TrackCandidate)[] = [];
    for (const q of queries) {
      await jlog('info', `Searching Soulseek for “${q}”…`);
      const responses = await slskd.search(q, settings.acquisition.searchTimeoutSec);
      const nFiles = responses.reduce((a, r) => a + r.files.length, 0);
      await jlog('info', `${responses.length} peer(s) responded with ${nFiles} file(s)`);
      const scored =
        target.kind === 'album'
          ? scoreAlbumCandidates(
              responses,
              {
                artistName: target.tracklist.artistName,
                albumTitle: target.tracklist.title,
                tracks: target.tracklist.tracks,
                discCount: target.tracklist.discCount,
              },
              settings.quality,
            )
          : scoreTrackCandidates(responses, target, settings.quality);
      candidates = scored.filter((c) => !isBlocked(c));
      const skipped = scored.length - candidates.length;
      if (skipped > 0) await jlog('info', `Skipped ${skipped} blocklisted candidate(s) from previous refetch`);
      if (candidates.length) break;
    }
    if (!candidates.length) {
      throw new PermanentError('No suitable candidates found on Soulseek (check quality settings and try again later)');
    }

    const tries = Math.min(candidates.length, Math.max(1, settings.acquisition.maxRetriesPerRequest));
    await jlog('info', `${candidates.length} viable candidate(s); will try up to ${tries}`);

    for (let i = 0; i < tries; i++) {
      const cand = candidates[i]!;
      const files = 'mapping' in cand ? cand.mapping.map((m) => m.file) : [cand.file];
      const mb2 = (n: number) => (n / 1024 / 1024).toFixed(1);
      await jlog(
        'info',
        `Candidate ${i + 1}/${tries}: ${cand.username} — ${files.length} ${cand.format} file(s), ${mb2(cand.totalBytes)} MB, score ${Math.round(cand.score)}`,
      );
      try {
        const localPaths = await this.download(req.id, cand.username, files, settings.acquisition.stallTimeoutMin, jlog);
        await this.setRequest(req.id, { status: 'processing', progress: null });
        await this.postProcess(req, target, cand, localPaths, jlog);
        await this.recordLastSource(req.id, cand);
        await this.finishAvailable(req, target, jlog);
        return;
      } catch (err) {
        if (err instanceof RequestGoneError || err instanceof PermanentError) throw err;
        await jlog('warn', `Candidate failed: ${(err as Error).message}`);
        if (i + 1 < tries) {
          await jlog('info', 'Falling back to the next candidate');
          await this.setRequest(req.id, { status: 'searching', progress: null });
        }
      }
    }
    throw new PermanentError(`All ${tries} candidate(s) failed`);
  }

  // ---------- download ----------

  private async download(
    requestId: string,
    username: string,
    files: SlskdSearchFile[],
    stallTimeoutMin: number,
    jlog: Jlog,
  ): Promise<string[]> {
    const { slskd, config } = this.deps;
    await slskd.enqueueDownloads(
      username,
      files.map((f) => ({ filename: f.filename, size: f.size })),
    );
    await this.setRequest(requestId, { status: 'downloading', progress: 0 });

    const wanted = new Set(files.map((f) => f.filename));
    const total = files.reduce((a, f) => a + f.size, 0);
    const stallMs = stallTimeoutMin * 60_000;
    const start = Date.now();
    let lastBytes = -1;
    let lastMovement = Date.now();
    let lastPublish = { at: 0, pct: -10 };

    // cancel anything still active and drop the records, so stale entries never
    // confuse a later retry or a re-download of the same files
    const cancelAll = async () => {
      const mine = (await slskd.downloads().catch(() => [])).filter(
        (t) => t.username === username && wanted.has(t.filename),
      );
      await Promise.all(mine.map((t) => slskd.cancelDownload(username, t.id, true).catch(() => {})));
    };

    for (;;) {
      await sleep(this.transferPollMs);
      // slskd keeps records of past transfers; keep only the newest per filename
      const byName = new Map<string, SlskdTransfer>();
      for (const t of await slskd.downloads()) {
        if (t.username === username && wanted.has(t.filename)) byName.set(t.filename, t);
      }
      const mine = [...byName.values()];

      const errored = mine.filter((t) => /Errored|Cancelled|TimedOut|Rejected/i.test(t.state));
      if (errored.length) {
        await cancelAll();
        throw new Error(`${errored.length} transfer(s) failed (${errored[0]!.state})`);
      }
      if (!mine.length && Date.now() - start > 30_000) {
        throw new Error('transfers never appeared in slskd');
      }

      const bytes = mine.reduce((a, t) => a + (t.bytesTransferred ?? 0), 0);
      const pct = total ? Math.min(100, (bytes / total) * 100) : 0;
      if (pct - lastPublish.pct >= 2 || Date.now() - lastPublish.at > 3000) {
        lastPublish = { at: Date.now(), pct };
        await this.setRequest(requestId, { progress: Math.round(pct * 10) / 10 });
      }
      if (bytes > lastBytes) {
        lastBytes = bytes;
        lastMovement = Date.now();
      } else if (Date.now() - lastMovement > stallMs) {
        await cancelAll();
        throw new Error(`download stalled for ${stallTimeoutMin} min`);
      }

      if (mine.length === wanted.size && mine.every((t) => t.state.includes('Succeeded'))) {
        // remove the completed records so they can't shadow a future transfer
        await Promise.all(mine.map((t) => slskd.cancelDownload(username, t.id, true).catch(() => {})));
        break;
      }
    }
    await jlog('info', `Download complete (${files.length} file(s))`);

    // slskd saves into <downloads>/<remote parent folder name>/<basename>
    const out: string[] = [];
    for (const f of files) {
      const parent = baseOf(dirOf(f.filename));
      const tryPaths = [
        path.join(config.slskdDownloadsPath!, parent, baseOf(f.filename)),
        path.join(config.slskdDownloadsPath!, baseOf(f.filename)),
      ];
      let found: string | null = null;
      for (let attempt = 0; attempt < 10 && !found; attempt++) {
        for (const p of tryPaths) {
          if (await fs.stat(p).then(() => true, () => false)) {
            found = p;
            break;
          }
        }
        if (!found) await sleep(1000);
      }
      if (!found) throw new Error(`downloaded file not found locally: ${baseOf(f.filename)}`);
      out.push(found);
    }
    return out;
  }

  // ---------- post-processing ----------

  private async postProcess(
    req: RequestRow,
    target: Target,
    cand: AlbumCandidate | TrackCandidate,
    localPaths: string[],
    jlog: Jlog,
  ): Promise<void> {
    const { config } = this.deps;
    const staging = path.join(config.stagingPath, req.id);
    await fs.mkdir(staging, { recursive: true });

    try {
      if (target.kind === 'album' && 'mapping' in cand) {
        const tl = target.tracklist;
        const [artistDir, albumDir] = albumDirParts(tl);
        const destRoot = path.join(config.musicLibraryPath, artistDir, albumDir);
        const cover = await fetchCover(tl.releaseGroupMbid);
        await jlog('info', cover ? 'Fetched cover art from the Cover Art Archive' : 'No cover art available');
        const discTrackCount = (disc: number) => tl.tracks.filter((t) => t.disc === disc).length;

        for (const [i, { track, file }] of cand.mapping.entries()) {
          const src = localPaths[i]!;
          const staged = path.join(staging, baseOf(src));
          await moveFile(src, staged);
          this.verify(staged, baseOf(file.filename));
          writeTags(staged, {
            title: track.title,
            artists: [track.artistName],
            albumArtist: tl.isVariousArtists ? 'Various Artists' : tl.artistName,
            album: tl.title,
            year: tl.year,
            trackNo: track.position,
            trackCount: discTrackCount(track.disc),
            discNo: track.disc,
            discCount: tl.discCount,
            mbRecordingId: track.recordingMbid || null,
            mbReleaseId: tl.releaseMbid,
            mbReleaseGroupId: tl.releaseGroupMbid,
            mbArtistId: tl.artistMbid,
            cover,
          });
          const dest = path.join(
            destRoot,
            trackFileName(track, { discCount: tl.discCount, isVariousArtists: tl.isVariousArtists, ext: extOf(file.filename) }),
          );
          await moveFile(staged, dest);
        }
        await jlog('info', `Tagged and moved ${cand.mapping.length} track(s) to ${artistDir}/${albumDir}`);
      } else if (target.kind === 'track' && 'file' in cand) {
        const artistDir = sanitizePathPart(target.artistName);
        const albumTitle = target.releaseTitle ?? 'Singles';
        const destRoot = path.join(config.musicLibraryPath, artistDir, sanitizePathPart(albumTitle));
        const cover = target.releaseGroupMbid ? await fetchCover(target.releaseGroupMbid) : null;
        const src = localPaths[0]!;
        const staged = path.join(staging, baseOf(src));
        await moveFile(src, staged);
        this.verify(staged, baseOf(cand.file.filename));
        writeTags(staged, {
          title: target.title,
          artists: [target.artistName],
          albumArtist: target.artistName,
          album: albumTitle,
          year: null,
          trackNo: 0,
          trackCount: 0,
          discNo: 0,
          discCount: 0,
          mbRecordingId: target.recordingMbid,
          mbReleaseGroupId: target.releaseGroupMbid,
          mbArtistId: target.artistMbid,
          cover,
        });
        const dest = path.join(destRoot, `${sanitizePathPart(target.title)}.${extOf(cand.file.filename)}`);
        await moveFile(staged, dest);
        await jlog('info', `Tagged and moved track to ${artistDir}/${sanitizePathPart(albumTitle)}`);
      }

      // tidy the slskd download folder if we emptied it
      for (const p of new Set(localPaths.map((p) => path.dirname(p)))) {
        if (p.startsWith(config.slskdDownloadsPath!) && p !== config.slskdDownloadsPath) {
          await fs.rmdir(p).catch(() => {});
        }
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  private verify(filePath: string, label: string): void {
    try {
      const { durationMs, bitrateKbps } = verifyAudio(filePath);
      this.deps.log.info(
        `verified ${label}: ${Math.round(durationMs / 1000)}s${bitrateKbps ? ` @ ${bitrateKbps}kbps` : ''}`,
      );
    } catch (err) {
      if (err instanceof AudioVerifyError) throw new Error(`${label}: ${err.message}`);
      throw err;
    }
  }

  // ---------- jellyfin handoff ----------

  private async finishAvailable(req: RequestRow, target: Target, jlog: Jlog): Promise<void> {
    const { jellyfin, config } = this.deps;
    await jlog('info', 'Triggering a Jellyfin library scan');
    await jellyfin.refreshLibrary(config.jellyfinApiKey!);

    const deadline = Date.now() + this.indexTimeoutMs;
    let rescanned = false;
    let indexed = false;
    while (Date.now() < deadline && !indexed) {
      await sleep(3000);
      indexed = await this.isIndexed(target).catch(() => false);
      if (!indexed && !rescanned && Date.now() > deadline - this.indexTimeoutMs / 2) {
        rescanned = true;
        await jellyfin.refreshLibrary(config.jellyfinApiKey!).catch(() => {});
      }
    }
    if (indexed) {
      await jlog('info', 'Jellyfin has indexed the new files');
    } else {
      await jlog('warn', 'Jellyfin did not index the files in time — marking available anyway');
    }
    await this.setRequest(req.id, { status: 'available', progress: null, availableAt: new Date(), errorMessage: null });
    await jlog('info', 'Request complete — available in the library');
    if (req.parentId) await this.rollupParent(req.parentId);
    // Slot this track into any import playlists that requested it — best-effort.
    if (this.deps.imports) {
      await this.deps.imports.onRequestAvailable(req.id).catch((err) => {
        this.deps.log.warn(`onRequestAvailable(${req.id}) failed: ${(err as Error).message}`);
      });
    }
  }

  private async isIndexed(target: Target): Promise<boolean> {
    const { jellyfin, config } = this.deps;
    const token = config.jellyfinApiKey!;
    if (target.kind === 'album') {
      const tl = target.tracklist;
      const res = await jellyfin.items(token, {
        IncludeItemTypes: 'MusicAlbum',
        Recursive: true,
        SearchTerm: tl.title,
        Limit: 30,
        Fields: 'ProviderIds,Path',
      });
      const wantTitle = normalizeForMatch(tl.title);
      const wantArtist = normalizeForMatch(tl.isVariousArtists ? 'Various Artists' : tl.artistName);
      return res.Items.some((item) => {
        if (item.ProviderIds?.MusicBrainzReleaseGroup === tl.releaseGroupMbid) return true;
        const artist = item.AlbumArtist ?? item.Artists?.[0] ?? '';
        return normalizeForMatch(item.Name ?? '') === wantTitle && normalizeForMatch(artist) === wantArtist;
      });
    }
    const res = await jellyfin.items(token, {
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SearchTerm: target.title,
      Limit: 50,
      Fields: 'ProviderIds,Path',
    });
    const wantTitle = normalizeForMatch(target.title);
    const wantArtist = normalizeForMatch(target.artistName);
    return res.Items.some((item) => {
      if (normalizeForMatch(item.Name ?? '') !== wantTitle) return false;
      const artists = [item.AlbumArtist, ...(item.Artists ?? [])].filter((a): a is string => !!a);
      return artists.some((a) => normalizeForMatch(a) === wantArtist);
    });
  }
}

async function moveFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}
