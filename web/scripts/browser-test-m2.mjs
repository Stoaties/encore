// M2 browser verification: MB search -> request -> admin approve (SSE) -> settings -> discography.
// Uses the real MusicBrainz API (server-side cached + rate limited).
// Usage: node scripts/browser-test-m2.mjs [baseUrl]
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const SHOTS = '/tmp/encore-shots';

const browser = await puppeteer.launch({
  executablePath: '/run/current-system/sw/bin/google-chrome-stable',
  headless: 'new',
  args: ['--mute-audio'],
});

const fail = async (msg, page) => {
  if (page) await page.screenshot({ path: `${SHOTS}/m2-failure.png` });
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

const bodyHas = (page, text, timeout = 20000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);

// "Albums"/"Artists" also appear in the sidebar nav, so wait for result buttons instead
const waitForButton = (page, text, timeout = 30000) =>
  page.waitForFunction(
    (t) => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === t),
    { timeout },
    text,
  );

// --- user requests an album ---
const user = await newSession('stoat', 'testpass');
await user.goto(`${BASE}/requests`, { waitUntil: 'networkidle2' });
await user.type('input[placeholder^="Artist"]', 'radiohead ok computer');
await user.keyboard.press('Enter');
await waitForButton(user, 'Request').catch(() => fail('MB search returned no requestable albums', user));
await sleep(500);
await user.screenshot({ path: `${SHOTS}/10-mb-search.png` });
console.log('OK MB search results');

if (!(await clickButtonByText(user, 'Request'))) await fail('no Request button in results', user);
await bodyHas(user, 'pending', 10000).catch(() => fail('request did not appear as pending', user));
await sleep(400);
await user.screenshot({ path: `${SHOTS}/11-request-pending.png` });
console.log('OK request created (pending)');

// --- admin sees it and approves; user page must update via SSE ---
const admin = await newSession('admin', 'testpass');
await admin.goto(`${BASE}/requests`, { waitUntil: 'networkidle2' });
await bodyHas(admin, 'pending', 10000).catch(() => fail('admin does not see the pending request', admin));
await admin.screenshot({ path: `${SHOTS}/12-admin-queue.png` });

const approved = await admin.evaluate(() => {
  const btn = document.querySelector('button[aria-label="Approve"]');
  if (btn) btn.click();
  return !!btn;
});
if (!approved) await fail('no Approve button for admin', admin);
await bodyHas(admin, 'approved', 10000).catch(() => fail('status did not become approved for admin', admin));
console.log('OK admin approve');

// the user page was NOT reloaded — SSE must refresh it
await user
  .waitForFunction(() => document.body.innerText.includes('approved'), { timeout: 8000 })
  .catch(() => fail('SSE did not propagate approval to the user page', user));
await user.screenshot({ path: `${SHOTS}/13-sse-approved.png` });
console.log('OK SSE live update on user page');

// --- admin settings panel ---
await clickButtonByText(admin, 'Admin settings');
await bodyHas(admin, 'Auto-approve requests from regular users', 5000).catch(() =>
  fail('admin settings panel did not open', admin),
);
await sleep(300);
await admin.screenshot({ path: `${SHOTS}/14-admin-settings.png` });
if (!(await clickButtonByText(admin, 'Save settings'))) await fail('no Save settings button', admin);
await bodyHas(admin, 'Saved', 5000).catch(() => fail('settings save did not confirm', admin));
console.log('OK admin settings save');

// --- artist discography view ---
await user.evaluate(() => {
  const input = document.querySelector('input[placeholder^="Artist"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'radiohead');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await user.keyboard.press('Enter');
await user
  .waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Discography')),
    { timeout: 30000 },
  )
  .catch(() => fail('artist search returned no Artists section', user));
const opened = await user.evaluate(() => {
  const row = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Discography'));
  if (row) row.click();
  return !!row;
});
if (!opened) await fail('no Discography expander', user);
await bodyHas(user, 'studio albums', 30000).catch(() => fail('discography did not load', user));
await sleep(1200);
await user.screenshot({ path: `${SHOTS}/15-discography.png` });
console.log('OK artist discography');

// --- cleanup: admin deletes the request ---
const deleted = await admin.evaluate(() => {
  const btn = document.querySelector('button[aria-label="Delete"]');
  if (btn) btn.click();
  return !!btn;
});
if (!deleted) await fail('no Delete button for admin', admin);
await admin
  .waitForFunction(() => document.body.innerText.includes('No requests yet'), { timeout: 8000 })
  .catch(() => fail('request was not deleted', admin));
console.log('OK delete + empty queue');

await browser.close();
console.log('ALL M2 BROWSER CHECKS PASSED');
