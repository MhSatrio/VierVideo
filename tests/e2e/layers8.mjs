// Layers in the studio (feedback round 8): a drag on empty space draws a selection rectangle, a group moves and resizes
// as one, an HTML element is added as a layer without touching the animation, and a group can be taken apart.
// Drives the real Electron app over CDP (Windows). Run:  node tests/e2e/layers8.mjs
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
const CDP_PORT = 9370;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e-layers8-'));
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
const allClips = () => readDoc().timeline.tracks.flatMap((t) => t.clips);
const clipOf = (pred) => allClips().find(pred);

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
  let connected = null;
  while (Date.now() < deadline) {
    try {
      connected = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      break;
    } catch {
      await sleep(400);
    }
  }
  assert(connected, 'could not connect to Electron over CDP');
  browser = connected;
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

/** The frame of the studio on screen: maps frame pixels (1080 x 1920) to screen points. */
async function frameMap(studio) {
  const box = await studio.getByTestId('composition-frame').boundingBox();
  return {
    box,
    at: (x, y) => [box.x + (box.width * x) / 1080, box.y + (box.height * y) / 1920],
  };
}

async function dragTo(from, to, steps = 8) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
  }
}

let failed = false;
try {
  console.log('VierVideo layers in the studio (feedback round 8)');
  await launch();

  await step('the example is open, with the logo and the caption on the timeline at 0.5 s', async () => {
    await page.locator('.app').waitFor({ timeout: 60000 });
    projectDir = (await page.evaluate(() => window.vv.state())).dir;
    await page.locator('input.scrubber').fill('500');
    await sleep(1200);
    assert(clipOf((c) => c.kind === 'image'), 'the example has no logo layer');
    assert(clipOf((c) => c.kind === 'text'), 'the example has no caption layer');
  });

  await step('the studio opens and snapping is turned off for exact moves', async () => {
    const c = await page.getByTestId('composition-frame').boundingBox();
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2, { button: 'right' });
    await page.getByTestId('open-studio').click();
    const studio = page.getByTestId('studio');
    await studio.waitFor();
    await studio.getByTestId('grid-snap').uncheck();
  });

  const studio = page.getByTestId('studio');

  await step('a drag from the corner across the layers draws a rectangle and selects both layers', async () => {
    const f = await frameMap(studio);
    const from = f.at(20, 20);
    const to = f.at(1060, 1900);
    await dragTo(from, to);
    await studio.getByTestId('marquee').waitFor({ timeout: 5000 });
    await page.mouse.up();
    await waitFor(async () => (await studio.locator('.layer-row.selected').count()) === 2, 'the two layers to be selected');
  });

  await step('the two selected layers are grouped', async () => {
    await studio.getByTestId('selection-info').waitFor({ timeout: 5000 });
    await studio.getByTestId('group-selection').click();
    await waitFor(() => {
      const logo = clipOf((c) => c.kind === 'image');
      const caption = clipOf((c) => c.kind === 'text');
      return Boolean(logo?.group) && logo.group === caption?.group;
    }, 'the logo and the caption to share a group', 30000);
  });

  await step('dragging one layer of the group moves both by 60 px', async () => {
    const f = await frameMap(studio);
    const logoBefore = clipOf((c) => c.kind === 'image');
    const from = f.at(logoBefore.x + logoBefore.w / 2, logoBefore.y + logoBefore.h / 2);
    await dragTo(from, [from[0] + (f.box.width * 60) / 1080, from[1]]);
    await page.mouse.up();
    await waitFor(() => clipOf((c) => c.kind === 'image').x === logoBefore.x + 60, 'the logo to move by 60 px', 30000);
    const logo = clipOf((c) => c.kind === 'image');
    const caption = clipOf((c) => c.kind === 'text');
    assert(Math.abs(caption.x - 120) <= 2, `the caption moved to x=${caption.x}, expected about 120`);
    assert(logo.group && logo.group === caption.group, 'the moved layers lost their group');
  });

  await step('dragging the top-left handle of the group by (-40, -40) resizes both layers', async () => {
    const handle = await studio.getByTestId('layer-handle-nw').boundingBox();
    const f = await frameMap(studio);
    const from = [handle.x + handle.width / 2, handle.y + handle.height / 2];
    const to = f.at(80, 20);
    await dragTo(from, to);
    await page.mouse.up();
    await waitFor(() => {
      const logo = clipOf((c) => c.kind === 'image');
      return logo.x <= 84 && logo.y <= 24;
    }, 'the group to resize', 30000);
    const logo = clipOf((c) => c.kind === 'image');
    const caption = clipOf((c) => c.kind === 'text');
    // The corner that stayed (bottom-right) is still at the caption's right edge (x = 1080).
    assert(Math.abs(caption.x + caption.w - 1080) <= 3, `the caption's right edge is at ${caption.x + caption.w}, expected 1080`);
    assert(Math.abs(logo.x - 80) <= 3 && Math.abs(logo.y - 20) <= 3, `the logo is at ${logo.x}, ${logo.y}, expected about 80, 20`);
    assert(caption.fontSize >= 48, `the caption font is ${caption.fontSize}`);
  });

  await step('an HTML element is added as a layer; the animation and its code stay as they were', async () => {
    const before = await page.evaluate(() => window.vv.renderComposition(500).then((r) => r.png));
    await studio.getByTestId('studio-add-element').click();
    const dialog = page.getByTestId('snippet-dialog');
    await dialog.waitFor();
    await page.getByTestId('snippet-html').fill(
      '<div id="probe" style="position:absolute;left:0;top:0;width:100%;height:100%;background:#ffcc00"><script>alert(1)</script><span onclick="x()">Probe</span></div>',
    );
    await page.getByTestId('snippet-name').fill('Probe element');
    await page.getByTestId('snippet-removed').waitFor();
    await page.getByTestId('snippet-add').click();
    await waitFor(() => Boolean(clipOf((c) => c.kind === 'snippet' && c.name === 'Probe element')), 'the element layer to be saved', 30000);
    const snip = clipOf((c) => c.kind === 'snippet');
    assert(snip.html.includes('id="probe"'), `the stored element lost its markup: ${snip.html}`);
    assert(!/script|onclick/i.test(snip.html), `the stored element kept a script or an event attribute: ${snip.html}`);
    assert(snip.start === 0.5, `the element starts at ${snip.start}, expected the playhead 0.5`);
    const after = await page.evaluate(() => window.vv.renderComposition(500).then((r) => r.png));
    assert(after !== before, 'the preview at 0.5 s did not change: the element is not drawn');
    const htmlAsset = readDoc().assets.find((a) => a.kind === 'html');
    assert(!htmlAsset.edited, 'the animation was marked as edited');
  });

  await step('the new element shows in the layer list and its HTML can be edited in the inspector', async () => {
    await studio.locator('.layer-row', { hasText: 'Probe element' }).first().waitFor();
    const area = studio.getByTestId('snippet-edit-html');
    await area.waitFor({ timeout: 10000 });
    const value = await area.inputValue();
    assert(value.includes('id="probe"'), 'the inspector does not show the element HTML');
  });

  await step('a click on the logo selects its group; Ungroup takes the layers apart', async () => {
    const f = await frameMap(studio);
    const logo = clipOf((c) => c.kind === 'image');
    await page.mouse.click(...f.at(logo.x + logo.w / 2, logo.y + logo.h / 2));
    await waitFor(async () => (await studio.locator('.layer-row.selected').count()) === 2, 'the group to be selected whole');
    await studio.getByTestId('ungroup-selection').click();
    await waitFor(() => clipOf((c) => c.kind === 'image').group === null && clipOf((c) => c.kind === 'text').group === null, 'the group to be taken apart', 30000);
  });

  console.log('\nAll layer checks passed.');
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
