// Feasibility spike (2026-11-17): deterministic frame capture of a Claude-generated requestAnimationFrame animation.
// Not part of the app. Stage 2 implements the same idea inside Electron.
//
// usage: node spikes/render-spike.mjs <outDir> <inputHtml> <seconds> [stillsOnly]
// Chromium: set CHROMIUM_PATH, or use the Playwright build in %LOCALAPPDATA%\ms-playwright.
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright-core');

const [, , outDir, inHtml, secArg, stillsArg] = process.argv;
if (!outDir || !inHtml) throw new Error('usage: node spikes/render-spike.mjs <outDir> <inputHtml> <seconds> [stillsOnly]');
const SECONDS = Number(secArg ?? 6);
const FPS = 30;
const stillsOnly = stillsArg === 'stillsOnly';
const exe = process.env.CHROMIUM_PATH
  || join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');
if (!existsSync(exe)) throw new Error('Chromium not found; set CHROMIUM_PATH: ' + exe);
const FONT = join(ROOT, 'node_modules', '@fontsource-variable', 'jost', 'files', 'jost-latin-wght-normal.woff2');

const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });

// Offline font: serve the local Jost so canvas text is identical on every machine.
await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({
  contentType: 'text/css',
  body: "@font-face{font-family:'Jost';font-style:normal;font-weight:100 900;src:url(https://fonts.gstatic.com/vv-jost.woff2) format('woff2');}",
}));
await page.route('https://fonts.gstatic.com/vv-jost.woff2', (r) => r.fulfill({ contentType: 'font/woff2', path: FONT }));

// Virtual clock: rAF callbacks are queued, not run; performance.now() returns our clock.
await page.addInitScript(() => {
  let now = 0;
  const q = [];
  performance.now = () => now;
  window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
  window.cancelAnimationFrame = () => {};
  window.__clock = {
    pending: () => q.length,
    run(t) { now = t; const cbs = q.splice(0); for (const cb of cbs) cb(t); return cbs.length; },
  };
});

await page.goto(pathToFileURL(inHtml).href, { waitUntil: 'load' });
await page.waitForFunction(() => window.__clock && window.__clock.pending() > 0, null, { timeout: 30000 });
await page.addStyleTag({ content: '#controls,#bar{display:none!important}' });

// 1) Seek test: jump straight to late timestamps (no playback needed).
for (const sec of [2, 30, 50]) {
  const png = await page.evaluate((t) => { window.__clock.run(t); return document.getElementById('c').toDataURL('image/png'); }, sec * 1000);
  writeFileSync(join(outDir, `still-${sec}s.png`), Buffer.from(png.split(',')[1], 'base64'));
}
console.log('stills written to', outDir);

if (!stillsOnly) {
  const mp4 = join(outDir, `silent-${SECONDS}s.mp4`);
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  const N = FPS * SECONDS;
  for (let i = 0; i < N; i++) {
    const t = Math.round((i * 1000) / FPS);
    const png = await page.evaluate((tt) => { window.__clock.run(tt); return document.getElementById('c').toDataURL('image/png'); }, t);
    if (!ff.stdin.write(Buffer.from(png.split(',')[1], 'base64'))) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await once(ff, 'close');
  const secs = (Date.now() - t0) / 1000;
  console.log(`encoded ${N} frames in ${secs.toFixed(1)} s (${(N / secs).toFixed(1)} fps), ffmpeg exit ${code}, -> ${mp4}`);
}
await browser.close();
