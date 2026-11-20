// Feedback round 7: the example project's timeline and sound. Moving and trimming clips with the mouse (any clip,
// narration included), clips stacked in rows so none hides another, the Fit button, the preview playing with its sound,
// and the developer tools of the animation. Drives the real Electron app over CDP (Windows).
// Run:  node tests/e2e/feedback7.mjs   (needs the built app: npx vite build first)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const electronExe = require('electron');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDP_PORT = 9365;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e-fb7-'));
const userData = path.join(work, 'user-data');

let proc = null;
let browser = null;
let page = null;
let projectDir = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const readDoc = () => JSON.parse(fs.readFileSync(path.join(projectDir, 'project.vvproj.json'), 'utf8'));
const clip = (track, name) => readDoc().timeline.tracks.find((t) => t.id === track).clips.find((c) => c.name.startsWith(name));

async function waitFor(pred, what, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

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
  const env = { ...process.env, VV_E2E: '1', VV_USER_DATA: userData, VV_AUTO_EXAMPLE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  proc = spawn(electronExe, [ROOT, `--remote-debugging-port=${CDP_PORT}`], { stdio: ['ignore', 'ignore', 'pipe'], env, cwd: ROOT });
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

/** Pixels per second of the timeline at the current zoom, from a clip whose length is known (its box width over its length). */
async function pixelsPerSecond(name, track = "music") {
  const c = clip(track, name);
  const box = await page.locator(`[data-track="${track}"] .tl-clip`, { hasText: name }).first().boundingBox();
  assert(c && box, `no box for ${name}`);
  return box.width / c.duration;
}

/** A real mouse drag of dx pixels from the middle (or `from`) of an element. */
async function drag(locator, dx, from = 0.5) {
  const box = await locator.boundingBox();
  assert(box, 'the element to drag has no box');
  const x = box.x + box.width * from;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y);
  await page.mouse.up();
  await sleep(500);
}

let failed = false;
try {
  console.log('VierVideo feedback round 7 (timeline and sound)');
  await launch();

  await step('the example opens; its music clips are in separate rows (none hides another)', async () => {
    await page.locator('.app').waitFor({ timeout: 60000 });
    projectDir = (await page.evaluate(() => window.vv.state())).dir;
    const chime = page.locator('[data-track="music"] .tl-clip', { hasText: 'Chime' });
    const drone = page.locator('[data-track="music"] .tl-clip', { hasText: 'Drone' });
    await chime.waitFor();
    await drone.waitFor();
    assert((await chime.getAttribute('data-row')) !== (await drone.getAttribute('data-row')), 'the chime and the drone are in the same row');
  });

  await step('the Fit button shows the whole timeline, so the right end of the drone can be reached', async () => {
    await page.getByTestId('timeline-fit').click();
    await sleep(300);
    const grip = page.locator('[data-track="music"] .tl-clip', { hasText: 'Drone' }).locator('.tl-grip.r');
    await grip.waitFor();
    const box = await grip.boundingBox();
    const width = await page.evaluate(() => window.innerWidth);
    assert(box && box.x > 0 && box.x + box.width < width, `the drone's right end is off screen (${JSON.stringify(box)}, window ${width})`);
  });

  await step('a music clip moves with the mouse (the chime 3 s later) and is saved', async () => {
    const chime = page.locator('[data-track="music"] .tl-clip', { hasText: 'Chime' });
    const before = clip('music', 'Chime').start;
    const pxPerSec = await pixelsPerSecond("Chime");
    await drag(chime, pxPerSec * 3, 0.5);
    await waitFor(() => clip('music', 'Chime').start > before + 2.5, 'the chime to move');
    assert(Math.abs(clip('music', 'Chime').start - (before + 3)) < 0.3, `chime start ${clip('music', 'Chime').start}`);
  });

  await step('the drone can be trimmed from its right end (60 s to about 30 s)', async () => {
    const grip = page.locator('[data-track="music"] .tl-clip', { hasText: 'Drone' }).locator('.tl-grip.r');
    const pxPerSec = await pixelsPerSecond("Drone");
    await drag(grip, -pxPerSec * 30, 0.5);
    await waitFor(() => clip('music', 'Drone').duration < 45, 'the drone to be trimmed');
    assert(Math.abs(clip('music', 'Drone').duration - 30) < 1, `drone duration ${clip('music', 'Drone').duration}`);
  });

  await step('the example narration is made by itself at the first start (the engine is installed here)', async () => {
    await waitFor(() => readDoc().narration?.segments.every((s) => s.status === 'ok'), 'the example narration to be generated', 240000);
  });

  await step('a narration clip moves in time (its segment moves with it; no trimming handles)', async () => {
    const seg = page.locator('[data-track="narration"] .tl-clip', { hasText: 'Vier Apparatus' });
    await seg.waitFor();
    assert((await page.locator('[data-track="narration"] .tl-clip', { hasText: 'Vier Apparatus' }).locator('.tl-grip').count()) === 0, 'a narration clip has trimming handles');
    const before = readDoc().narration.segments.find((s) => s.id === 'seg002').start;
    await seg.scrollIntoViewIfNeeded(); // the narration row is below the music rows: scroll the timeline to it
    const pxPerSec = await pixelsPerSecond("Vier Apparatus", "narration");
    await drag(seg, pxPerSec * 1, 0.5);
    await waitFor(() => readDoc().narration.segments.find((s) => s.id === 'seg002').start > before + 0.5, 'the narration segment to move');
    const after = readDoc().narration.segments.find((s) => s.id === 'seg002');
    assert(Math.abs(after.start - (before + 1)) < 0.3, `segment start ${before} -> ${after.start}`);
    assert(after.status === 'ok' && after.file, 'moving the segment lost its audio');
    assert(Math.abs(clip('narration', 'Vier Apparatus').start - after.start) < 0.01, 'the narration clip is not where its segment is');
  });

  await step('play: the preview plays the timeline sound, and pause stops it', async () => {
    const sound = page.getByTestId('preview-sound');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    try {
      await waitFor(async () => (await sound.evaluate((a) => a.currentTime)) > 0.3, 'the sound to play', 120000);
    } catch (err) {
      const note = await page.getByTestId('sound-note').textContent().catch(() => '(no message)');
      throw new Error(`${err.message}. The preview said: ${note}`);
    }
    assert((await sound.evaluate((a) => a.paused)) === false, 'the sound is not playing');
    assert(String(await sound.getAttribute('src')).includes('vvproj://file/audio/preview-'), `sound source: ${await sound.getAttribute('src')}`);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await waitFor(async () => (await sound.evaluate((a) => a.paused)) === true, 'the sound to pause');
  });

  await step('in the studio, the animation canvas is not moved (its parts cannot be picked yet), and its code is shown', async () => {
    const htmlAsset = () => readDoc().assets.find((a) => a.kind === 'html');
    const c = await page.getByTestId('composition-frame').boundingBox();
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2, { button: 'right' });
    await page.getByTestId('open-studio').click();
    const studio = page.getByTestId('studio');
    await studio.waitFor();
    const box = await studio.getByTestId('composition-frame').boundingBox();
    const scale = box.width / 1080;
    const sx = box.x + box.width * (540 / 1080);
    const sy = box.y + box.height * (860 / 1920);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(sx + (60 * scale * i) / 8, sy);
    await page.mouse.up();
    // A press now lands on a part of the animation when there is one (it can then move); otherwise on the canvas (refused).
    await page.locator('[data-testid="element-whole-frame"], [data-testid="element-part"]').first().waitFor({ timeout: 30000 });
    await sleep(800);
    assert((htmlAsset().render?.elementOffsets ?? []).length === 0, 'the whole canvas was moved');
    if (await page.getByTestId('element-whole-frame').count()) {
      const source = page.getByTestId('element-source');
      await source.waitFor({ timeout: 30000 });
      const shown = await source.textContent();
      assert(shown.includes('<canvas id="c"'), `the code shown for the element does not name it: ${shown.slice(0, 120)}`);
    }
    await page.getByTestId('studio-close').click();
  });

  await step('the developer tools for the animation open on the animation page (not the app)', async () => {
    const opened = await page.evaluate(() => window.vv.e2eAnimationDevtools());
    assert(opened === true, `the developer tools of the animation's page are not open (${opened})`);
  });

  console.log('\nAll feedback round 7 checks passed.');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await stop();
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (err) {
    console.warn(`could not remove ${work}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
