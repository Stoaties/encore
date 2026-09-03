// Renders the app icon SVG to the PNG sizes the PWA manifest needs.
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <rect width="512" height="512" rx="96" fill="#09090b"/>
  <circle cx="256" cy="256" r="170" fill="none" stroke="#34d399" stroke-width="28"/>
  <circle cx="256" cy="256" r="112" fill="none" stroke="#34d399" stroke-width="10" opacity="0.45"/>
  <circle cx="256" cy="256" r="42" fill="#34d399"/>
  <circle cx="256" cy="256" r="12" fill="#09090b"/>
</svg>`;

const browser = await puppeteer.launch({
  executablePath: '/run/current-system/sw/bin/google-chrome-stable',
  headless: 'new',
});
const page = await browser.newPage();
for (const size of [512, 192]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>*{margin:0}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}">`,
  );
  const buf = await page.screenshot({ type: 'png', omitBackground: true });
  writeFileSync(new URL(`../public/icons/icon-${size}.png`, import.meta.url), buf);
  console.log(`icon-${size}.png written`);
}
await browser.close();
