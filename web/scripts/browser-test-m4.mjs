// M4 browser verification: Jellyfin-native playlists (create/add/remove/delete),
// favorites, smart shuffle + playback events, and Spotify playlist import with
// live MusicBrainz matching -> review screen -> track requests -> acquisition.
// Requires: mock slskd (MOCK_FLAKY=1), mock spotify (import-mock.mjs), API server
// with SPOTIFY_* pointing at the mock, vite dev server, OK Computer in the library.
// Usage: node scripts/browser-test-m4.mjs [baseUrl]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const SHOTS = '/tmp/encore-shots';
const LIBRARY = '/home/stoat/musicApp/test-stack/library';
const JF_URL = 'http://localhost:8096';
const JF_KEY = 'd4edfc4707fa48caa9f5493625ee80dc';
const IMPORT_URL = 'https://open.spotify.com/playlist/MOCKPL01';

const browser = await puppeteer.launch({
  executablePath: '/run/current-system/sw/bin/google-chrome-stable',
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const fail = async (msg, page) => {
  if (page) await page.screenshot({ path: `${SHOTS}/m4-failure.png` }).catch(() => {});
  console.error(`FAIL: ${msg}`);
  await browser.close();
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const countFlacs = (dir) => {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFlacs(path.join(dir, e.name));
    else if (e.name.endsWith('.flac')) n++;
  }
  return n;
};

async function newSession(username, password) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (err) => console.error(`PAGE ERROR (${username}):`, err.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  await page.type('input[autocomplete="username"]', username);
  await page.type('input[autocomplete="current-password"]', password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('button[type="submit"]')]);
  return page;
}

const clickButtonByText = (page, text) =>
  page.evaluate((t) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === t);
    if (btn) btn.click();
    return !!btn;
  }, text);

const clickByAria = (page, label, nth = 0) =>
  page.evaluate(
    (l, i) => {
      const els = document.querySelectorAll(`button[aria-label="${l}"]`);
      if (!els[i]) return false;
      els[i].click();
      return true;
    },
    label,
    nth,
  );

const waitForButton = (page, text, timeout = 30000) =>
  page.waitForFunction(
    (t) => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === t),
    { timeout },
    text,
  );

const bodyHas = (page, text, timeout = 20000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);

const bodyText = (page) => page.evaluate(() => document.body.innerText);

// tracklist rows: title of every row that has an add-to-playlist button
const rowTitles = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('button[aria-label="Add to playlist"]')].map(
      (b) => b.closest('div')?.parentElement?.querySelector('.font-medium')?.textContent?.trim() ?? '?',
    ),
  );

const removeButtonCount = (page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('button[aria-label^="Remove "]')].filter(
        (b) => b.getAttribute('aria-label') !== 'Remove from favorites',
      ).length,
  );

const flacsBefore = countFlacs(LIBRARY);
const admin = await newSession('admin', 'testpass');
console.log(`OK admin session (library has ${flacsBefore} flacs)`);

// ---------- playlists: create via track row, add second track ----------
await admin.goto(`${BASE}/albums`, { waitUntil: 'networkidle2' });
await bodyHas(admin, 'OK Computer').catch(() => fail('OK Computer missing from Albums', admin));
await admin.evaluate(() => {
  const el = [...document.querySelectorAll('a,button,div')].find((n) => n.textContent?.trim() === 'OK Computer');
  (el?.closest('a') ?? el)?.click();
});
await waitForButton(admin, 'Smart shuffle', 15000).catch(() => fail('album page did not open / no Smart shuffle button', admin));
const albumTracks = await rowTitles(admin);
if (albumTracks.length < 10) await fail(`expected a full tracklist, got ${albumTracks.length} rows`, admin);
const [trackA, trackB] = albumTracks;

if (!(await clickByAria(admin, 'Add to playlist', 0))) await fail('no add-to-playlist button on row', admin);
await waitForButton(admin, 'New playlist…', 5000).catch(() => fail('playlist dropdown did not open', admin));
await clickButtonByText(admin, 'New playlist…');
await admin.waitForSelector('input[aria-label="New playlist name"]', { timeout: 5000 });
await admin.type('input[aria-label="New playlist name"]', 'E2E Mix');
await admin.keyboard.press('Enter');
await admin
  .waitForFunction(() => !document.querySelector('input[aria-label="New playlist name"]'), { timeout: 15000 })
  .catch(() => fail('playlist create form did not close (create failed?)', admin));
console.log(`OK created playlist "E2E Mix" with "${trackA}"`);

await clickByAria(admin, 'Add to playlist', 1);
await waitForButton(admin, 'E2E Mix', 8000).catch(() => fail('new playlist not listed in dropdown', admin));
await clickButtonByText(admin, 'E2E Mix');
await sleep(1500); // mutation + 600ms auto-close
console.log(`OK added "${trackB}" to the playlist`);

// ---------- playlist page: contents + remove a track ----------
await admin.goto(`${BASE}/playlists`, { waitUntil: 'networkidle2' });
await bodyHas(admin, 'E2E Mix').catch(() => fail('E2E Mix card missing on Playlists page', admin));
await bodyHas(admin, 'Liked Songs').catch(() => fail('Liked Songs card missing', admin));
await admin.evaluate(() => {
  const el = [...document.querySelectorAll('a')].find((n) => n.textContent?.includes('E2E Mix'));
  el?.click();
});
await bodyHas(admin, 'Playlist', 10000);
await admin
  .waitForFunction(
    (a, b) => document.body.innerText.includes(a) && document.body.innerText.includes(b),
    { timeout: 15000 },
    trackA,
    trackB,
  )
  .catch(() => fail(`playlist page missing "${trackA}" / "${trackB}"`, admin));
if ((await removeButtonCount(admin)) !== 2) await fail('expected 2 removable rows in the playlist', admin);
await admin.screenshot({ path: `${SHOTS}/30-m4-playlist.png` });

await clickByAria(admin, `Remove ${trackA}`);
await admin
  .waitForFunction(
    (t) => !document.body.innerText.includes(t),
    { timeout: 15000 },
    trackA,
  )
  .catch(() => fail('removed track still shown in playlist', admin));
if ((await removeButtonCount(admin)) !== 1) await fail('expected 1 row after removal', admin);
console.log(`OK removed "${trackA}" from the playlist`);

// ---------- the playlist must be Jellyfin-native ----------
const users = await (await fetch(`${JF_URL}/Users?api_key=${JF_KEY}`)).json();
const jfAdmin = users.find((u) => u.Name === 'admin');
if (!jfAdmin) await fail('admin user missing in Jellyfin', admin);
const jfPls = await (
  await fetch(`${JF_URL}/Users/${jfAdmin.Id}/Items?IncludeItemTypes=Playlist&Recursive=true&api_key=${JF_KEY}`)
).json();
const jfPl = (jfPls.Items ?? []).find((p) => p.Name === 'E2E Mix');
if (!jfPl) await fail(`playlist not visible via Jellyfin API (got: ${(jfPls.Items ?? []).map((p) => p.Name).join(', ')})`, admin);
console.log(`OK playlist exists natively in Jellyfin (id ${jfPl.Id})`);

// ---------- favorites ----------
await clickByAria(admin, 'Add to favorites');
await admin
  .waitForSelector('button[aria-label="Remove from favorites"]', { timeout: 10000 })
  .catch(() => fail('heart did not switch to favorited', admin));
await admin.goto(`${BASE}/playlists`, { waitUntil: 'networkidle2' });
await admin
  .waitForFunction(() => document.querySelector('a[href="/favorites"]')?.innerText.includes('1 track'), { timeout: 10000 })
  .catch(() => fail('Liked Songs card does not show 1 track', admin));
await admin.goto(`${BASE}/favorites`, { waitUntil: 'networkidle2' });
await bodyHas(admin, trackB, 10000).catch(() => fail(`favorites page missing "${trackB}"`, admin));
await admin.screenshot({ path: `${SHOTS}/31-m4-favorites.png` });
await clickByAria(admin, 'Remove from favorites');
await bodyHas(admin, 'Nothing here yet', 10000).catch(() => fail('favorites did not empty after un-heart', admin));
console.log('OK favorites: heart, Liked Songs count, page, un-heart');

// ---------- smart shuffle + playback events ----------
await admin.goto(`${BASE}/albums`, { waitUntil: 'networkidle2' });
await admin.evaluate(() => {
  const el = [...document.querySelectorAll('a,button,div')].find((n) => n.textContent?.trim() === 'OK Computer');
  (el?.closest('a') ?? el)?.click();
});
await waitForButton(admin, 'Smart shuffle', 15000);
await clickButtonByText(admin, 'Smart shuffle');
await admin
  .waitForFunction(
    () => {
      const s = window.__encorePlayer?.getState();
      return !!s && s.queue.length >= 10 && s.isPlaying && s.positionSec > 0;
    },
    { timeout: 30000 },
  )
  .catch(() => fail('smart shuffle did not start playback with a full queue', admin));
const queueInfo = await admin.evaluate(() => {
  const s = window.__encorePlayer.getState();
  return { len: s.queue.length, unique: new Set(s.queue.map((t) => t.id)).size, now: s.queue[s.index]?.name };
});
if (queueInfo.len !== queueInfo.unique) await fail('smart shuffle queue has duplicates', admin);
await admin.screenshot({ path: `${SHOTS}/32-m4-smartshuffle.png` });
console.log(`OK smart shuffle playing (${queueInfo.len} tracks, now: "${queueInfo.now}")`);

await clickByAria(admin, 'Next');
await sleep(2000); // fire-and-forget event posts
const plays = execSync(
  `docker exec encore-test-pg psql -U musicapp -d musicapp -tAc "select event || ':' || count(*) from track_plays group by event order by event"`,
)
  .toString()
  .trim();
if (!/play:[2-9]/.test(plays) || !plays.includes('skip:')) await fail(`track_plays incomplete: [${plays.replace(/\n/g, ' ')}]`, admin);
console.log(`OK playback events recorded (${plays.replace(/\n/g, ' ')})`);

// ---------- import: paste URL -> resolving -> review ----------
await admin.goto(`${BASE}/playlists`, { waitUntil: 'networkidle2' });
await admin.type('input[aria-label="Playlist URL"]', IMPORT_URL);
await clickButtonByText(admin, 'Import');
await admin
  .waitForFunction(() => location.pathname.startsWith('/imports/'), { timeout: 10000 })
  .catch(() => fail('did not navigate to the import review page', admin));
await bodyHas(admin, 'Matching tracks against MusicBrainz', 20000).catch(() =>
  fail('resolving banner never appeared', admin),
);
await admin.screenshot({ path: `${SHOTS}/33-m4-import-resolving.png` });
console.log('OK import resolving (live SSE banner)');

await bodyHas(admin, 'will be requested', 180000).catch(() => fail('import never reached review', admin));
const review = await bodyText(admin);
if (!review.includes('Encore Test Mix')) await fail('playlist title missing on review screen', admin);
if ((review.match(/In library/g) ?? []).length !== 2) await fail('expected exactly 2 "In library" chips', admin);
if (!review.includes('No match found')) await fail('unmatched row missing "No match found"', admin);
if (!review.includes('Request 1 track(s)')) await fail(`expected "Request 1 track(s)" initially, got: ${review.match(/Request \d+ track/)?.[0]}`, admin);

// score pill colors: Nude auto (emerald), Weird Fishez needs review (amber)
const pills = await admin.evaluate(() => {
  const row = (label) => document.querySelector(`button[aria-label="Accept match for ${label}"]`)?.closest('div.rounded-md');
  const pill = (label) => row(label)?.querySelector('[class*="emerald"],[class*="amber"]')?.className ?? '';
  return { nude: pill('Nude'), weird: pill('Weird Fishez Arpeggi Reverb') };
});
if (!pills.nude.includes('emerald')) await fail(`Nude score pill not emerald: "${pills.nude}"`, admin);
if (!pills.weird.includes('amber')) await fail(`Weird Fishez score pill not amber: "${pills.weird}"`, admin);
await admin.screenshot({ path: `${SHOTS}/34-m4-import-review.png` });
console.log('OK review screen (2 in library, 1 auto, 1 needs review, 1 unmatched)');

// ---------- reject, re-accept, confirm ----------
await clickByAria(admin, 'Reject match for Weird Fishez Arpeggi Reverb');
await sleep(200);
if (!(await admin.evaluate(() => !!document.querySelector('div.opacity-50')))) await fail('rejected row not dimmed', admin);
await clickByAria(admin, 'Accept match for Weird Fishez Arpeggi Reverb');
await waitForButton(admin, 'Request 2 track(s)', 5000).catch(() => fail('accepting the match did not bump the count', admin));
await clickButtonByText(admin, 'Request 2 track(s)');
await admin
  .waitForFunction(() => (document.body.innerText.match(/Requested/g) ?? []).length >= 2, { timeout: 90000 })
  .catch(() => fail('confirm did not produce 2 "Requested" chips', admin));
// the status chip is CSS-capitalized, so innerText renders "Done"
await admin
  .waitForFunction(() => /\bdone\b/i.test(document.body.innerText), { timeout: 10000 })
  .catch(() => fail('batch did not reach done', admin));
await admin.screenshot({ path: `${SHOTS}/35-m4-import-done.png` });
console.log('OK confirmed: 2 track requests created');

// ---------- both track requests must be acquired ----------
await admin.goto(`${BASE}/requests`, { waitUntil: 'networkidle2' });
await bodyHas(admin, 'Nude', 15000).catch(() => fail('Nude request missing on Requests page', admin));
await admin
  .waitForFunction(() => (document.body.innerText.match(/\bavailable\b/g) ?? []).length >= 2, { timeout: 300000 })
  .catch(() => fail('both track requests never reached available', admin));
await admin.screenshot({ path: `${SHOTS}/36-m4-requests-available.png` });
const flacsAfter = countFlacs(LIBRARY);
if (flacsAfter !== flacsBefore + 2) await fail(`expected ${flacsBefore + 2} flacs after import, found ${flacsAfter}`, admin);
console.log(`OK both tracks acquired and tagged into the library (${flacsAfter} flacs)`);

// ---------- delete the playlist through the UI (confirm dialog auto-accepted) ----------
await admin.goto(`${BASE}/playlists`, { waitUntil: 'networkidle2' });
await admin.evaluate(() => {
  const el = [...document.querySelectorAll('a')].find((n) => n.textContent?.includes('E2E Mix'));
  el?.click();
});
await admin.waitForSelector('button[aria-label="Delete playlist"]', { timeout: 10000 });
await clickByAria(admin, 'Delete playlist');
await admin
  .waitForFunction(() => location.pathname === '/playlists', { timeout: 10000 })
  .catch(() => fail('delete did not navigate back to /playlists', admin));
await sleep(800);
if ((await bodyText(admin)).includes('E2E Mix')) await fail('deleted playlist still listed', admin);
await admin.screenshot({ path: `${SHOTS}/37-m4-playlists-final.png` });
console.log('OK playlist deleted through the UI');

await browser.close();
console.log('ALL M4 BROWSER CHECKS PASSED');
