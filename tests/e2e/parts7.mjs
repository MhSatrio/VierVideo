// Parts of a canvas-drawn animation (option 1): the studio picks one paint call of the animation (here the letter C),
// moves it by dragging, the offset is saved, the part is drawn at its new place, and reset puts it back.
// Drives the real Electron app over CDP (Windows). Run:  node tests/e2e/parts7.mjs
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
const CDP_PORT = 9369;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e-parts7-'));
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
const htmlAsset = () => readDoc().assets.find((a) => a.kind === 'html');

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

let failed = false;
let letterC = null;
const T = 7333; // ms: the carbon scene (the letter C) is on screen here; the scene at 0 s is only the title
try {
  console.log('VierVideo parts of a canvas-drawn animation (option 1)');
  await launch();

  await step('the animation lists its paint calls, and one of them is the letter C', async () => {
    await page.locator('.app').waitFor({ timeout: 60000 });
    projectDir = (await page.evaluate(() => window.vv.state())).dir;
    await page.locator('input.scrubber').fill(String(T)); // seek to the carbon scene
    await sleep(1500);
    const ops = await page.evaluate((t) => window.vv.e2eOps(t), T);
    assert(ops.length > 3, `only ${ops.length} paint calls were recorded`);
    const kinds = {};
    for (const o of ops) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
    console.log(`       paint calls: ${ops.length} ${JSON.stringify(kinds)}`);
    letterC = ops.find((o) => o.kind === 'text' && o.text === 'C') ?? null;
    assert(letterC, `no paint call draws the letter C (texts drawn: ${JSON.stringify(ops.filter((o) => o.text).map((o) => o.text))})`);
  });

  await step('in the studio, pressing the letter C selects that part and names it', async () => {
    const c = await page.getByTestId('composition-frame').boundingBox();
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2, { button: 'right' });
    await page.getByTestId('open-studio').click();
    const studio = page.getByTestId('studio');
    await studio.waitFor();
    await studio.getByTestId('grid-snap').uncheck(); // snapping is on by default: this check measures the exact move
    const box = await studio.getByTestId('composition-frame').boundingBox();
    const cx = (letterC.bbox[0] + letterC.bbox[2]) / 2;
    const cy = (letterC.bbox[1] + letterC.bbox[3]) / 2;
    await page.mouse.click(box.x + (box.width * cx) / 1080, box.y + (box.height * cy) / 1920);
    await page.getByTestId('element-part').waitFor({ timeout: 30000 });
    assert((await page.getByTestId('element-info').getAttribute('data-tag')) === 'text', 'the press did not pick the text part');
    assert((await studio.textContent()).includes('Text “C”'), 'the panel does not name the letter C');
  });

  await step('dragging the letter C by 60 px saves the move, and the part is drawn 60 px further right', async () => {
    const studio = page.getByTestId('studio');
    const box = await studio.getByTestId('composition-frame').boundingBox();
    const scale = box.width / 1080;
    const cx = (letterC.bbox[0] + letterC.bbox[2]) / 2;
    const cy = (letterC.bbox[1] + letterC.bbox[3]) / 2;
    const sx = box.x + (box.width * cx) / 1080;
    const sy = box.y + (box.height * cy) / 1920;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(sx + (60 * scale * i) / 8, sy);
    await page.mouse.up();
    await waitFor(async () => (htmlAsset().render?.opOffsets ?? []).length > 0, 'the part move to be saved', 30000);
    const saved = htmlAsset().render.opOffsets[0];
    assert(saved.index === letterC.index && Math.abs(saved.dx - 60) < 3 && Math.abs(saved.dy) < 3, `saved move ${JSON.stringify(saved)}`);
    await sleep(500);
    const after = (await page.evaluate((t) => window.vv.e2eOps(t), T)).find((o) => o.index === letterC.index);
    assert(after, 'the letter C is no longer in the list');
    assert(Math.abs(after.bbox[0] - (letterC.bbox[0] + 60)) < 3, `the letter C is at ${after.bbox[0]}, expected ${letterC.bbox[0] + 60}`);
  });

  await step('reset puts the letter C back where the animation draws it', async () => {
    await page.getByTestId('element-reset').click();
    await waitFor(async () => (htmlAsset().render?.opOffsets ?? []).length === 0, 'the reset to clear the move', 30000);
    await sleep(500);
    const back = (await page.evaluate((t) => window.vv.e2eOps(t), T)).find((o) => o.index === letterC.index);
    assert(back && Math.abs(back.bbox[0] - letterC.bbox[0]) < 3, `after reset the letter C is at ${back?.bbox[0]}, expected ${letterC.bbox[0]}`);
  });

  console.log('\nAll parts checks passed.');
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
