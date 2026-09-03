// Mock Spotify Web API for playlist-import testing.
// Serves the token endpoint + one playlist with REAL track names, so the
// import pipeline exercises live MusicBrainz matching.
//
//   node import-mock.mjs   (port 5031)
//   point the server at it with:
//     SPOTIFY_TOKEN_URL=http://localhost:5031/api/token
//     SPOTIFY_API_URL=http://localhost:5031
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 5031);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const track = (name, artist, album, duration_ms) => ({
  track: { name, duration_ms, type: 'track', artists: [{ name: artist }], album: album ? { name: album } : undefined },
});

const PLAYLIST = {
  name: 'Encore Test Mix',
  items: [
    // in the test library already (imported during the M3 run)
    track('Karma Police', 'Radiohead', 'OK Computer', 261_000),
    track('No Surprises', 'Radiohead', 'OK Computer', 228_000),
    // clean auto match, not in the library -> becomes a request
    track('Nude', 'Radiohead', 'In Rainbows', 255_000),
    // mangled title + bogus duration -> needs review. The misspelling matters:
    // MB has a length-less "Weird Fishes" by Radiohead, and any source title
    // *containing* that phrase hits 0.85 containment + renorm = 0.906 -> auto.
    track('Weird Fishez Arpeggi Reverb', 'Radiohead', null, 600_000),
    // hopeless -> unmatched. Every word must be pure nonsense — MB returned a
    // real "Nonexistent" recording that hit 0.85 title containment and slipped
    // into needs_review
    track('Xqzzv Flombitkr Zqrblydt', 'Qwrtplk Ensemble', null, 123_000),
    // provider junk the fetcher must skip
    { track: null },
    { track: { name: 'Some Podcast Episode', type: 'episode' } },
  ],
};

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  log(`${req.method} ${url.pathname}`);
  if (req.method === 'POST' && url.pathname === '/api/token') {
    return json(res, 200, { access_token: 'mock-spotify-token', token_type: 'Bearer', expires_in: 3600 });
  }
  if (url.pathname === '/v1/playlists/MOCKPL01') {
    return json(res, 200, { name: PLAYLIST.name });
  }
  if (url.pathname === '/v1/playlists/MOCKPL01/tracks') {
    return json(res, 200, { items: PLAYLIST.items, total: PLAYLIST.items.length });
  }
  if (/^\/v1\/playlists\//.test(url.pathname)) return json(res, 404, { error: { status: 404 } });
  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => log(`mock spotify on :${PORT}`));
