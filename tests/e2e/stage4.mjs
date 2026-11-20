// Stage 4 end-to-end test: the timeline and layers. Drives the real Electron app over CDP.
// Adds the FTIR animation, text and shapes; edits them in the inspector; moves, trims, splits and deletes clips
// with the mouse; exports the timeline as a video and checks it; checks the project after a restart.
// Run:  npm run build && node tests/e2e/stage4.mjs     (needs ffmpeg and ffprobe on PATH)
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const electronExe = require('electron');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDP_PORT = 9345;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e4-'));
const parent = path.join(work, 'projects');
const userData = path.join(work, 'user-data');
const PROJECT_DIR = path.join(parent, 'Timeline stage 4');
const FTIR = path.join(ROOT, 'tests', 'fixtures', 'ftir-60s.html');
const LOGO = path.join(work, 'logo.svg');
const DUR = 6;
fs.mkdirSync(parent, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'public', 'icon.svg'), LOGO);

let proc = null;
let browser = null;
let page = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const readDoc = () => JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.vvproj.json'), 'utf8'));
const tracksDoc = () => readDoc().timeline.tracks;
const clipsOn = (track) => tracksDoc().find((t) => t.id === track).clips;
const allClips = () => tracksDoc().flatMap((t) => t.clips);

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    throw err;
  }
}

async function launch() {
  const busy = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  if (busy) throw new Error(`Port ${CDP_PORT} is already in use by an earlier VierVideo test. Close that Electron window first.`);
  const env = { ...process.env, VV_E2E: '1', VV_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(electronExe, [ROOT, `--remote-debugging-port=${CDP_PORT}`], { stdio: ['ignore', 'ignore', 'pipe'], env, cwd: ROOT });
  proc.stderr.on('data', (d) => {
    if (process.env.VV_DEBUG) process.stderr.write(String(d));
  });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      break;
    } catch {
      await sleep(400);
    }
  }
  assert(browser, 'could not connect to Electron over CDP');
  const ctx = browser.contexts()[0];
  page = ctx.pages()[0] ?? (await ctx.waitForEvent('page'));
  await page.waitForLoadState('domcontentloaded');
}

async function stop() {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  browser = null;
  if (proc && proc.exitCode === null) {
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      setTimeout(resolve, 8000);
    });
  }
  proc = null;
  await sleep(800);
}

const setPicks = (p) => page.evaluate((x) => window.vv.e2eSetPicks(x), p);
const statusText = () => page.locator('.status-line').first().innerText();
async function waitStatus(re, timeout = 900000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.status-line')?.textContent ?? ''), re.source, { timeout });
}
/** Drags an element by dx, dy pixels with the mouse (real pointer events). */
async function drag(locator, dx, dy = 0, from = 0.5) {
  const box = await locator.boundingBox();
  assert(box, 'element has no box to drag');
  const x = box.x + box.width * from;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
  await sleep(300);
}
const zoomPx = 40; // the default timeline zoom (pixels per second)

let failed = false;
try {
  console.log('VierVideo stage 4 end-to-end (timeline and layers)');
  await launch();

  await step('create the project, set it to 6 s, import the animation and a logo', async () => {
    await page.locator('.start').waitFor();
    await setPicks({ folder: parent });
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill('Timeline stage 4');
    await page.getByRole('button', { name: 'Choose folder' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.locator('.app').waitFor();
    await page.locator('.timeline-tools').getByLabel('Timeline duration in seconds').fill(String(DUR));
    await page.locator('.timeline-tools').getByRole('button', { name: 'Set' }).click();
    await page.waitForFunction((d) => (document.querySelector('.timeline-tools')?.closest('.panel')?.textContent ?? '').includes(`${d} s`), DUR);
    await setPicks({ files: [FTIR, LOGO] });
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await page.locator('.asset-card', { hasText: 'ftir-60s.html' }).waitFor();
    await page.locator('.asset-card', { hasText: 'logo.svg' }).waitFor();
  });

  await step('the animation goes on the HTML track, from the library selection', async () => {
    await page.locator('.asset-card', { hasText: 'ftir-60s.html' }).click();
    await page.getByTestId('add-html').click();
    await page.locator('[data-track="html"] .tl-clip').waitFor();
    const html = clipsOn('html');
    assert(html.length === 1 && html[0].kind === 'html' && html[0].start === 0 && html[0].duration === DUR, `html clip: ${JSON.stringify(html)}`);
  });

  await step('a second animation is refused with a message', async () => {
    await page.getByTestId('add-html').click();
    await page.waitForFunction(() => /one HTML animation/.test(document.querySelector('.status-line')?.textContent ?? ''), null, { timeout: 30000 });
    assert((await page.locator('[data-track="html"] .tl-clip').count()) === 1, 'a second animation was added');
  });

  await step('the composition preview shows the animation at the playhead', async () => {
    await page.locator('.asset-card[aria-pressed="true"]').click(); // clear the library selection
    await page.waitForFunction(() => document.querySelector('.frame img')?.getAttribute('src')?.startsWith('data:image/png'), null, { timeout: 90000 });
  });

  let textId;
  await step('add text at the playhead and write its words in the inspector', async () => {
    await page.getByTestId('add-text').click();
    await page.locator('.tl-clip[data-kind="text"]').waitFor();
    textId = await page.locator('.tl-clip[data-kind="text"]').getAttribute('data-clip');
    await page.getByLabel('Text content').fill('Hello from the timeline');
    await page.getByLabel('Text content').press('Tab');
    await page.waitForFunction(() => document.querySelector('.tl-clip[data-kind="text"]')?.textContent?.includes('Hello from the timeline'));
    const t = allClips().find((c) => c.id === textId);
    assert(t && t.text === 'Hello from the timeline' && t.start === 0 && t.duration === 3, `text clip: ${JSON.stringify(t)}`);
  });

  await step('a text layer moves when its X position is set in the inspector', async () => {
    const before = await page.locator('[data-testid="composition-frame"] img').getAttribute('src');
    await page.getByLabel('X (px)').fill('300');
    await page.getByLabel('X (px)').press('Enter');
    await page.waitForFunction((prev) => document.querySelector('[data-testid="composition-frame"] img')?.getAttribute('src') !== prev, before, { timeout: 60000 });
    assert(allClips().find((c) => c.id === textId).x === 300, 'x was not saved');
  });

  // A 3 s clip at 4 s would run past the 6 s project, so it is placed at 2 s (new clips stay inside the project).
  await step('add a rectangle at 2 s (move the playhead there with the ruler first)', async () => {
    const ruler = page.getByTestId('ruler');
    const box = await ruler.boundingBox();
    await page.mouse.click(box.x + 2 * zoomPx + 1, box.y + box.height / 2);
    try {
      await page.waitForFunction(() => /0:02\.0/.test(document.querySelector('.timecode')?.textContent ?? ''), null, { timeout: 30000 });
    } catch (err) {
      const tc = await page.locator('.timecode').allInnerTexts();
      const slider = await page.locator('input.scrubber').inputValue().catch(() => '?');
      throw new Error(`playhead did not move to 2 s. timecode: ${JSON.stringify(tc)} slider: ${slider} ruler box: ${JSON.stringify(box)}`);
    }
    await page.getByTestId('add-rect').click();
    await page.locator('.tl-clip[data-kind="shape"]').waitFor();
    const r = allClips().find((c) => c.kind === 'shape');
    assert(r && r.track === 'visual' && Math.abs(r.start - 2) < 0.05, `rect: ${JSON.stringify(r)}`);
  });

  let rectId;
  await step('drag the rectangle along the timeline: its start moves by about 1 s', async () => {
    rectId = await page.locator('.tl-clip[data-kind="shape"]').getAttribute('data-clip');
    const before = allClips().find((c) => c.id === rectId).start;
    await drag(page.locator(`[data-clip="${rectId}"]`), zoomPx * 1);
    await page.waitForFunction(({ id, before }) => {
      const el = document.querySelector(`[data-clip="${id}"]`);
      return !!el && el.style.left !== '' && Math.abs(parseFloat(el.style.left) / 40 - (before + 1)) < 0.2;
    }, { id: rectId, before }, { timeout: 30000 });
    const after = allClips().find((c) => c.id === rectId).start;
    assert(Math.abs(after - (before + 1)) < 0.15, `start moved from ${before} to ${after}`);
  });

  await step('drag the rectangle end to trim it shorter', async () => {
    const before = allClips().find((c) => c.id === rectId).duration;
    await drag(page.locator(`[data-clip="${rectId}"] .tl-grip.r`), -zoomPx * 1, 0, 0.5);
    await sleep(500);
    const after = allClips().find((c) => c.id === rectId).duration;
    assert(after < before - 0.5, `duration ${before} -> ${after}`);
  });

  await step('split the text clip at the playhead (S) and delete the second half (Delete)', async () => {
    const ruler = page.getByTestId('ruler');
    const box = await ruler.boundingBox();
    await page.mouse.click(box.x + 1.5 * zoomPx + 1, box.y + box.height / 2);
    await page.waitForFunction(() => /0:01\.5/.test(document.querySelector('.timecode')?.textContent ?? ''), null, { timeout: 30000 });
    await page.locator(`[data-clip="${textId}"]`).click();
    await page.keyboard.press('s');
    await page.waitForFunction(() => document.querySelectorAll('.tl-clip[data-kind="text"]').length === 2, null, { timeout: 30000 });
    const texts = allClips().filter((c) => c.kind === 'text').sort((a, b) => a.start - b.start);
    assert(texts.length === 2 && Math.abs(texts[0].duration - 1.5) < 0.05 && Math.abs(texts[1].start - 1.5) < 0.05, `split: ${JSON.stringify(texts)}`);
    const second = texts[1].id;
    await page.locator(`[data-clip="${second}"]`).click();
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => document.querySelectorAll('.tl-clip[data-kind="text"]').length === 1, null, { timeout: 30000 });
    assert(allClips().filter((c) => c.kind === 'text').length === 1, 'the second half was not deleted');
  });

  await step('the inspector edits fade in, opacity and placement of the shape', async () => {
    await page.locator(`[data-clip="${rectId}"]`).click();
    await page.getByLabel('Fade in (s)').fill('0.5');
    await page.getByLabel('Fade in (s)').press('Enter');
    await page.getByLabel('Opacity').fill('0.6');
    await page.getByLabel('Opacity').press('Enter');
    await sleep(400);
    const r = allClips().find((c) => c.id === rectId);
    assert(r.fadeIn === 0.5 && Math.abs(r.opacity - 0.6) < 0.01, `shape: ${JSON.stringify(r)}`);
  });

  await step('a shape cannot be moved to the text track: refused with a message, nothing changes', async () => {
    await page.locator(`[data-clip="${rectId}"]`).click();
    await page.getByLabel('Track').selectOption('text');
    await page.waitForFunction(() => /cannot go on the text track/.test(document.querySelector('.status-line')?.textContent ?? ''), null, { timeout: 30000 });
    assert(allClips().find((c) => c.id === rectId).track === 'visual', 'the shape moved tracks');
  });

  await step('export the timeline as a video (6 s, 30 fps)', async () => {
    await page.getByTestId('export-timeline').click();
    await waitStatus(/Exported timeline/);
    const doc = readDoc();
    const rec = doc.renders.find((r) => r.kind === 'timeline');
    assert(rec, 'no timeline render was recorded');
    const file = path.join(PROJECT_DIR, rec.file);
    assert(fs.existsSync(file), 'export file missing');
    const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt:format=duration', '-of', 'json', file], { encoding: 'utf8' });
    const j = JSON.parse(out.stdout);
    assert(j.streams[0].codec_name === 'h264' && j.streams[0].width === 1080 && j.streams[0].height === 1920, `format: ${JSON.stringify(j.streams[0])}`);
    assert(Math.abs(Number(j.format.duration) - DUR) < 0.15, `duration ${j.format.duration}`);
  });

  await step('the timeline survives a restart', async () => {
    const before = allClips().map((c) => [c.kind, c.track, c.start, c.duration]).sort();
    await page.locator('.topbar').getByRole('button', { name: 'Close project' }).click();
    await stop();
    await launch();
    await page.locator('.recent-item button.open', { hasText: 'Timeline stage 4' }).click();
    await page.locator('.app').waitFor();
    await page.locator('[data-clip]').first().waitFor();
    const after = allClips().map((c) => [c.kind, c.track, c.start, c.duration]).sort();
    assert(JSON.stringify(after) === JSON.stringify(before), `timeline changed: ${JSON.stringify(after)}`);
  });

  console.log('\nAll Stage 4 end-to-end checks passed.');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await stop();
  if (process.env.VV_KEEP !== '1') fs.rmSync(work, { recursive: true, force: true });
  else console.log('kept', work);
}
process.exit(failed ? 1 : 0);
