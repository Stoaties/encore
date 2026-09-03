// M3 browser verification: request -> auto-approve -> slskd download (with flaky
// first candidate fallback) -> tag/rename -> Jellyfin scan -> available -> playable.
// Requires: mock slskd running with MOCK_FLAKY=1, API server, vite dev server.
// Usage: node scripts/browser-test-m3.mjs [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const SHOTS = '/tmp/encore-shots';
const LIBRARY = '/home/stoat/musicApp/test-stack/library';

const browser = await puppeteer.launch({
  executablePath: '/run/current-system/sw/bin/google-chrome-stable',
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const fail = async (msg, page) => {
  if (page) await page.screenshot({ path: `${SHOTS}/m3-failure.png` });
  console.error(`FAIL: ${msg}`);
  await browser.close();
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newSession(username, password) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (err) => console.error(`PAGE ERROR (${username}):`, err.message));
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

const waitForButton = (page, text, timeout = 30000) =>
  page.waitForFunction(
    (t) => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === t),
    { timeout },
    text,
  );

const bodyHas = (page, text, timeout = 20000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);

// --- admin requests an album (auto-approved for admins) ---
const admin = await newSession('admin', 'testpass');
await admin.goto(`${BASE}/requests`, { waitUntil: 'networkidle2' });
await admin.type('input[placeholder^="Artist"]', 'radiohead ok computer');
await admin.keyboard.press('Enter');
await waitForButton(admin, 'Request').catch(() => fail('MB search returned no requestable albums', admin));
await sleep(300);
if (!(await clickButtonByText(admin, 'Request'))) await fail('no Request button in results', admin);
console.log('OK request created');

// auto-approve should kick it straight into the pipeline; guard for manual approve
const started = await admin
  .waitForFunction(
    () => /searching|downloading|processing|available/.test(document.body.innerText),
    { timeout: 15000 },
  )
  .then(() => true)
  .catch(() => false);
if (!started) {
  const btn = await admin.$('button[aria-label="Approve"]');
  if (!btn) await fail('request neither started nor approvable', admin);
  await btn.click();
  await admin
    .waitForFunction(() => /searching|downloading|processing|available/.test(document.body.innerText), { timeout: 15000 })
    .catch(() => fail('pipeline did not start after manual approve', admin));
}
console.log('OK pipeline started (searching/downloading)');
await admin.screenshot({ path: `${SHOTS}/20-m3-searching.png` });

// --- open the live logs panel ---
const logsBtn = await admin.waitForSelector('button[aria-label="Logs"]', { timeout: 10000 }).catch(() => null);
if (!logsBtn) await fail('no Logs button on the request card', admin);
await logsBtn.click();
// generous: a transient failure reschedules the job with a 30s backoff
await bodyHas(admin, 'Searching Soulseek', 120000).catch(() => fail('logs panel shows no search activity', admin));
console.log('OK live logs panel');

// --- download progress must surface ---
await admin
  .waitForFunction(() => document.body.innerText.includes('downloading'), { timeout: 150000 })
  .catch(() => fail('request never reached downloading', admin));
await sleep(1500);
await admin.screenshot({ path: `${SHOTS}/21-m3-downloading.png` });
console.log('OK downloading status');

// --- flaky first candidate must fall back, then complete ---
await bodyHas(admin, 'available', 240000).catch(() => fail('request never became available', admin));
await sleep(500);
await admin.screenshot({ path: `${SHOTS}/22-m3-available.png` });
const logText = await admin.evaluate(() => document.body.innerText);
for (const needle of ['Candidate failed', 'Falling back to the next candidate', 'Download complete', 'Tagged and moved', 'Request complete']) {
  if (!logText.includes(needle)) await fail(`log line missing: "${needle}"`, admin);
}
console.log('OK available + fallback exercised (flaky peer -> next candidate)');

// --- files must be tagged/renamed into the library tree ---
const albumDir = path.join(LIBRARY, 'Radiohead', 'OK Computer');
if (!fs.existsSync(albumDir)) await fail(`library dir missing: ${albumDir}`, admin);
const tracks = fs.readdirSync(albumDir).filter((f) => f.endsWith('.flac')).sort();
if (tracks.length < 10) await fail(`expected a full album in ${albumDir}, found: ${tracks.join(', ')}`, admin);
if (!/^01 - .+\.flac$/.test(tracks[0])) await fail(`bad track naming: ${tracks[0]}`, admin);
console.log(`OK library layout (${tracks.length} tracks, first: "${tracks[0]}")`);

// --- the album must appear in the library UI and play ---
await admin.goto(`${BASE}/albums`, { waitUntil: 'networkidle2' });
let inLibrary = false;
for (let i = 0; i < 30 && !inLibrary; i++) {
  inLibrary = await admin.evaluate(() => document.body.innerText.includes('OK Computer'));
  if (!inLibrary) {
    await sleep(3000);
    await admin.reload({ waitUntil: 'networkidle2' });
  }
}
if (!inLibrary) await fail('OK Computer never appeared in the Albums view', admin);
await admin.screenshot({ path: `${SHOTS}/23-m3-album-in-library.png` });
console.log('OK album visible in library');

await admin.evaluate(() => {
  const el = [...document.querySelectorAll('a,button,div')].find((n) => n.textContent?.trim() === 'OK Computer');
  (el?.closest('a') ?? el)?.click();
});
await bodyHas(admin, 'Play', 15000).catch(() => fail('album page did not open', admin));
await clickButtonByText(admin, 'Play');
await admin
  .waitForFunction(() => {
    const s = window.__encorePlayer?.getState();
    return !!s?.isPlaying && s.positionSec > 0;
  }, { timeout: 20000 })
  .catch(() => fail('playback did not start', admin));
const nowPlaying = await admin.evaluate(() => {
  const s = window.__encorePlayer?.getState();
  return s?.queue?.[s.index]?.name ?? '';
});
await admin.screenshot({ path: `${SHOTS}/24-m3-playing.png` });
console.log(`OK playback started ("${nowPlaying}")`);

// --- cleanup the request row (library files stay) ---
await admin.goto(`${BASE}/requests`, { waitUntil: 'networkidle2' });
const delBtn = await admin.$('button[aria-label="Delete"]');
if (delBtn) {
  await delBtn.click();
  await admin
    .waitForFunction(() => document.body.innerText.includes('No requests yet'), { timeout: 8000 })
    .catch(() => {});
}

await browser.close();
console.log('ALL M3 BROWSER CHECKS PASSED');
