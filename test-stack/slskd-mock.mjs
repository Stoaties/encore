// Mock slskd for local testing of the acquisition pipeline.
// Implements the API surface Encore uses (searches + download transfers) and
// "downloads" by generating real sine-wave FLAC/MP3 files with ffmpeg.
//
//   node slskd-mock.mjs            (port 5030, api key "devkey")
//   MOCK_FLAKY=1 node slskd-mock.mjs   -> adds a top-scoring peer whose transfers always fail
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 5030);
const API_KEY = process.env.SLSKD_API_KEY ?? 'devkey';
const DOWNLOADS = process.env.SLSKD_DOWNLOADS_PATH ?? new URL('./slskd-files/downloads', import.meta.url).pathname;
const FLAKY = process.env.MOCK_FLAKY === '1';

const searches = new Map(); // id -> { id, searchText, state, createdAt }
const transfers = new Map(); // username -> Map<id, transfer>

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- canned search results ----------

const N_TRACKS = 30;

function albumFiles(searchText, ext, sizeMb, extra) {
  const dir = `@@mock\\Music\\${searchText}`;
  return Array.from({ length: N_TRACKS }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return {
      filename: `${dir}\\${n} - ${searchText} Track ${n}.${ext}`,
      size: Math.round(sizeMb * 1024 * 1024),
      ...extra,
    };
  });
}

function singleFiles(searchText, ext, sizeMb, extra) {
  return [
    {
      filename: `@@mock\\Singles\\${searchText}.${ext}`,
      size: Math.round(sizeMb * 1024 * 1024),
      ...extra,
    },
  ];
}

function responsesFor(searchText) {
  const flacMeta = { bitDepth: 16, sampleRate: 44100 };
  const out = [
    {
      username: 'flacster',
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 800_000,
      files: [...albumFiles(searchText, 'flac', 24, flacMeta), ...singleFiles(searchText, 'flac', 24, flacMeta)],
    },
    {
      username: 'mp3joe',
      hasFreeUploadSlot: true,
      queueLength: 3,
      uploadSpeed: 200_000,
      files: [...albumFiles(searchText, 'mp3', 9, { bitRate: 320 }), ...singleFiles(searchText, 'mp3', 9, { bitRate: 320 })],
    },
    {
      username: 'lowrate_larry', // should always be filtered out by minBitrateKbps
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 900_000,
      files: [...albumFiles(searchText, 'mp3', 3, { bitRate: 128 }), ...singleFiles(searchText, 'mp3', 3, { bitRate: 128 })],
    },
  ];
  if (FLAKY) {
    out.unshift({
      username: 'flaky',
      hasFreeUploadSlot: true,
      queueLength: 0,
      uploadSpeed: 5_000_000,
      files: [...albumFiles(searchText, 'flac', 24, flacMeta), ...singleFiles(searchText, 'flac', 24, flacMeta)],
    });
  }
  return out;
}

// ---------- fake downloading (ffmpeg generation) ----------

let ffmpegChain = Promise.resolve();

function generateAudio(dest, trackNo, ext) {
  const freq = 220 + (trackNo % 24) * 30;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=8`];
  if (ext === 'flac') args.push('-ar', '44100', '-sample_fmt', 's16');
  else args.push('-codec:a', 'libmp3lame', '-b:a', '320k');
  args.push(dest);
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, (err) => (err ? reject(err) : resolve()));
  });
}

const baseOf = (p) => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));

function startTransfer(username, file) {
  const t = {
    id: randomUUID(),
    filename: file.filename,
    size: file.size,
    bytesTransferred: 0,
    state: 'Queued, Remotely',
  };
  if (!transfers.has(username)) transfers.set(username, new Map());
  transfers.get(username).set(t.id, t);

  void (async () => {
    await new Promise((r) => setTimeout(r, 300));
    if (username === 'flaky') {
      t.state = 'InProgress';
      t.bytesTransferred = Math.round(t.size * 0.2);
      await new Promise((r) => setTimeout(r, 700));
      t.state = 'Completed, Errored';
      log(`transfer FAILED (flaky): ${baseOf(t.filename)}`);
      return;
    }
    t.state = 'InProgress';
    for (let step = 1; step <= 5; step++) {
      if (t.state !== 'InProgress') return; // cancelled
      await new Promise((r) => setTimeout(r, 350));
      t.bytesTransferred = Math.round((t.size * step) / 5);
    }
    const base = baseOf(t.filename);
    const parent = baseOf(dirOf(t.filename));
    const destDir = path.join(DOWNLOADS, parent);
    const dest = path.join(destDir, base);
    const trackNo = Number(/^(\d+)/.exec(base)?.[1] ?? 1);
    const ext = base.split('.').pop().toLowerCase();
    ffmpegChain = ffmpegChain.then(async () => {
      await mkdir(destDir, { recursive: true });
      const tmp = path.join(destDir, `.tmp-${t.id}.${ext}`);
      await generateAudio(tmp, trackNo, ext);
      await rename(tmp, dest);
      t.state = 'Completed, Succeeded';
      log(`transfer done: ${parent}/${base}`);
    });
    await ffmpegChain.catch((err) => {
      t.state = 'Completed, Errored';
      log(`ffmpeg failed for ${base}: ${err.message}`);
    });
  })();
  return t;
}

// ---------- http plumbing ----------

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const seg = url.pathname.split('/').filter(Boolean); // ['api','v0',...]
  if (seg[0] !== 'api' || seg[1] !== 'v0') return json(res, 404, { error: 'not found' });
  if (req.headers['x-api-key'] !== API_KEY) return json(res, 401, { error: 'bad api key' });
  const rest = seg.slice(2);

  // searches
  if (rest[0] === 'searches') {
    if (req.method === 'POST' && rest.length === 1) {
      const body = (await readBody(req)) ?? {};
      const s = { id: randomUUID(), searchText: body.searchText ?? '', state: 'InProgress', createdAt: Date.now() };
      searches.set(s.id, s);
      setTimeout(() => (s.state = 'Completed, TimedOut'), 800);
      log(`search: "${s.searchText}"`);
      return json(res, 200, { id: s.id, state: s.state });
    }
    const s = searches.get(rest[1]);
    if (!s) return json(res, 404, { error: 'unknown search' });
    if (req.method === 'GET' && rest.length === 2) return json(res, 200, { id: s.id, state: s.state });
    if (req.method === 'GET' && rest[2] === 'responses') {
      return json(res, 200, s.state === 'InProgress' ? [] : responsesFor(s.searchText));
    }
    if (req.method === 'DELETE') {
      searches.delete(s.id);
      return json(res, 200);
    }
  }

  // transfers
  if (rest[0] === 'transfers' && rest[1] === 'downloads') {
    if (req.method === 'POST' && rest.length === 3) {
      const username = decodeURIComponent(rest[2]);
      const files = (await readBody(req)) ?? [];
      log(`download request from "${username}": ${files.length} file(s)`);
      for (const f of files) startTransfer(username, f);
      return json(res, 201);
    }
    if (req.method === 'GET' && rest.length === 2) {
      const out = [];
      for (const [username, byId] of transfers) {
        const dirs = new Map();
        for (const t of byId.values()) {
          const d = dirOf(t.filename);
          if (!dirs.has(d)) dirs.set(d, []);
          dirs.get(d).push(t);
        }
        out.push({
          username,
          directories: [...dirs.entries()].map(([directory, files]) => ({ directory, fileCount: files.length, files })),
        });
      }
      return json(res, 200, out);
    }
    if (req.method === 'DELETE' && rest.length === 4) {
      const t = transfers.get(decodeURIComponent(rest[2]))?.get(decodeURIComponent(rest[3]));
      if (t && !t.state.includes('Completed')) t.state = 'Completed, Cancelled';
      if (url.searchParams.get('remove') === 'true') transfers.get(decodeURIComponent(rest[2]))?.delete(decodeURIComponent(rest[3]));
      return json(res, 200);
    }
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => log(`mock slskd on :${PORT} (downloads -> ${DOWNLOADS}${FLAKY ? ', FLAKY mode' : ''})`));
