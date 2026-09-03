// End-to-end browser verification of M1: login -> browse -> play -> skip.
// Usage: node scripts/browser-test.mjs [baseUrl]
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const SHOTS = '/tmp/encore-shots';
const USER = process.env.TEST_USER ?? 'stoat';
const PASS = process.env.TEST_PASS ?? 'testpass';

const browser = await puppeteer.launch({
  executablePath: '/run/current-system/sw/bin/google-chrome-stable',
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));

const fail = async (msg) => {
  await page.screenshot({ path: `${SHOTS}/failure.png` });
  console.error(`FAIL: ${msg}`);
  await browser.close();
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const playerState = () => page.evaluate(() => window.__encorePlayer?.getState() ?? null);

// --- login ---
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
await page.screenshot({ path: `${SHOTS}/01-login.png` });
await page.type('input[autocomplete="username"]', USER);
await page.type('input[autocomplete="current-password"]', PASS);
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('button[type="submit"]')]);
if (new URL(page.url()).pathname !== '/') await fail(`expected redirect to /, got ${page.url()}`);

// --- home ---
await page.waitForFunction(() => document.body.innerText.includes('Recently added'), { timeout: 10000 });
await page.screenshot({ path: `${SHOTS}/02-home.png` });
console.log('OK login + home');

// --- album page (want one with several tracks so Next has somewhere to go) ---
const albumHrefs = await page.evaluate(() =>
  [...new Set([...document.querySelectorAll('a[href^="/library/albums/"]')].map((a) => a.getAttribute('href')))],
);
let albumTracks = 0;
for (const href of albumHrefs) {
  await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('Play'), { timeout: 10000 });
  await sleep(300);
  albumTracks = await page.evaluate(() => {
    const m = document.body.innerText.match(/·\s*(\d+) tracks\s*·/);
    return m ? Number(m[1]) : 0;
  });
  if (albumTracks >= 3) break;
}
if (albumTracks < 3) await fail('no album with >=3 tracks found on home');
await page.screenshot({ path: `${SHOTS}/03-album.png` });

// --- play ---
const playBtn = await page.$$('button');
let clicked = false;
for (const b of playBtn) {
  const txt = await b.evaluate((el) => el.textContent?.trim());
  if (txt === 'Play') {
    await b.click();
    clicked = true;
    break;
  }
}
if (!clicked) await fail('no Play button found on album page');
await sleep(2500);
let s = await playerState();
if (!s) await fail('player state hook missing');
if (s.index !== 0 || s.queue.length !== albumTracks) {
  await fail(`unexpected queue state ${JSON.stringify({ index: s.index, len: s.queue.length, albumTracks })}`);
}
if (!s.isPlaying) await fail('expected isPlaying=true after Play click');
const pos1 = s.positionSec;
await sleep(2000);
s = await playerState();
if (!(s.positionSec > pos1)) await fail(`position did not advance (${pos1} -> ${s.positionSec})`);
console.log(`OK playback: track "${s.queue[s.index].name}" playing, position ${s.positionSec.toFixed(1)}s`);
await page.screenshot({ path: `${SHOTS}/04-playing.png` });

// --- skip next ---
await page.click('button[aria-label="Next"]');
await sleep(1500);
s = await playerState();
if (s.index !== 1) await fail(`expected index 1 after Next, got ${s.index}`);
if (!s.isPlaying) await fail('expected playback to continue after skip');
console.log(`OK skip: now playing "${s.queue[s.index].name}"`);

// --- seek ---
await page.$eval('input[aria-label="Seek"]', (el) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, 5);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(700);
s = await playerState();
if (Math.abs(s.positionSec - 5) > 2.5) await fail(`seek to 5s landed at ${s.positionSec}`);
console.log('OK seek');

// --- search page ---
await page.goto(`${BASE}/search`, { waitUntil: 'networkidle2' });
await page.type('input[placeholder^="Search"]', 'burrow');
await page.waitForFunction(() => document.body.innerText.includes('Burrow Dance'), { timeout: 10000 });
await page.screenshot({ path: `${SHOTS}/05-search.png` });
console.log('OK search');

// --- mobile viewport sanity ---
await page.setViewport({ width: 390, height: 844 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await sleep(500);
await page.screenshot({ path: `${SHOTS}/06-mobile-home.png` });
console.log('OK mobile render');

await browser.close();
console.log('ALL M1 BROWSER CHECKS PASSED');
