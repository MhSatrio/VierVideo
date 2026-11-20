// Moving one part of a canvas-drawn animation must not move any other part, in any scene (feedback round 9).
// The FTIR animation is imported fresh from the Downloads folder (or VV_FTIR_HTML), the wave of its "Every molecule"
// scene is moved in the studio, and then every second of the video is compared with the state before the move: only the
// wave may differ. Drives the real Electron app over CDP (Windows). Run:  node tests/e2e/scenes9.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const electronExe = require('electron');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDP_PORT = 9371;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e-scenes9-'));
const userData = path.join(work, 'user-data');
const projects = path.join(work, 'projects');
const FTIR =
  process.env.VV_FTIR_HTML || path.join(os.homedir(), 'Downloads', 'FTIR Spectroscopy in 60 Seconds _ Vier Apparatus (1).html');
const SECONDS = 60;

let proc = null;
let stderrText = '';
let browser = null;
let page = null;
let projectDir = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const readDoc = () => JSON.parse(fs.readFileSync(path.join(projectDir, 'project.vvproj.json'), 'utf8'));
const htmlAsset = () => readDoc().assets.find((a) => a.kind === 'html');
const htmlClips = () => readDoc().timeline.tracks.flatMap((t) => t.clips).filter((c) => c.kind === 'html');

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
  const env = { ...process.env, VV_E2E: '1', VV_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VV_AUTO_EXAMPLE;
  proc = spawn(electronExe, [ROOT, `--remote-debugging-port=${CDP_PORT}`], { stdio: ['ignore', 'ignore', 'pipe'], env, cwd: ROOT });
  proc.stderr.on('data', (d) => { stderrText = (stderrText + d.toString()).slice(-4000); });
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

/** The paint calls of the animation at a time (seconds). */
const opsAt = (sec) => page.evaluate((ms) => window.vv.e2eOps(ms), sec * 1000);

/** Maps frame pixels (1080 x 1920) to screen points, on the studio's frame. */
async function frameMap(studio) {
  const box = await studio.getByTestId('composition-frame').boundingBox();
  return { box, at: (x, y) => [box.x + (box.width * x) / 1080, box.y + (box.height * y) / 1920] };
}

async function dragTo(from, to, steps = 8) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
  }
  await page.mouse.up();
}

const width = (op) => op.bbox[2] - op.bbox[0];

let failed = false;
let wave = null; // the wave's paint call at its scene's time
let waveT = -1;
let before = [];
try {
  console.log('VierVideo: a moved part does not move other parts (feedback round 9)');
  await launch();
  const studioFrame = () => page.getByTestId('studio').getByTestId('composition-frame');

  await step('a new project is made, and the FTIR file from Downloads is imported into it', async () => {
    await page.waitForSelector('.recent-item button.open, .app', { timeout: 60000 }).catch(() => {});
    await page.evaluate(
      (p) => window.vv.createProject(p),
      { parentDir: projects, name: 'Scenes check', settings: { aspect: '9:16', fps: 30, durationSec: SECONDS } },
    );
    await page.evaluate(() => window.vv.closeProject());
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.recent-item button.open').first().click({ timeout: 60000 });
    await page.locator('.app').waitFor({ timeout: 60000 });
    projectDir = (await page.evaluate(() => window.vv.state())).dir;
    await page.evaluate((f) => window.vv.e2eSetPicks({ files: [f] }), FTIR);
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await waitFor(() => readDoc().assets.some((a) => a.kind === 'html'), 'the FTIR file to be imported', 60000);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(FTIR)).digest('hex');
    assert(htmlAsset().sha256 === hash, 'the imported copy is not the file from Downloads');
  });

  await step('the imported animation is added to the timeline', async () => {
    await page.locator('.asset-card', { hasText: 'FTIR Spectroscopy' }).first().click();
    await page.getByTestId('add-html').click();
    await waitFor(() => htmlClips().length === 1, 'the animation clip', 30000);
    // A selected asset replaces the timeline's preview with the asset's own preview; clicking it again clears that.
    await page.locator('.asset-card', { hasText: 'FTIR Spectroscopy' }).first().click();
    await sleep(1500);
  });

  await step('the two scenes are found: "Every molecule" (wave) and "Stretching" (spring)', async () => {
    for (let t = 0; t < SECONDS; t++) {
      const ops = await opsAt(t);
      if (waveT < 0 && ops.some((o) => o.kind === 'text' && o.text.includes('Every molecule'))) waveT = t;
      if (waveT >= 0) break;
    }
    assert(waveT >= 0, 'no second of the video shows "Every molecule"');
    const ops = await opsAt(waveT);
    const strokes = ops.filter((o) => o.kind === 'stroke' && width(o) > 200);
    assert(strokes.length > 0, `no wide stroke (the wave) at ${waveT} s`);
    wave = strokes.reduce((a, b) => (width(b) > width(a) ? b : a));
    console.log(`       wave: paint call #${wave.index} at ${waveT} s, box ${wave.bbox.map((v) => Math.round(v)).join(', ')}`);
  });

  // Every second of the video, before the move: the reference for the comparison below.
  await step('the state of every second of the video is recorded before the move', async () => {
    before = [];
    for (let t = 0; t < SECONDS; t++) before.push(await opsAt(t));
  });

  await step('the wave is moved 120 px to the right in the studio, at its own scene', async () => {
    await page.locator('input.scrubber').fill(String(waveT * 1000));
    await sleep(1200);
    const c = await page.getByTestId('composition-frame').boundingBox();
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2, { button: 'right' });
    await page.getByTestId('open-studio').click();
    const studio = page.getByTestId('studio');
    await studio.waitFor();
    await studio.getByTestId('grid-snap').uncheck();
    const f = await frameMap(studio);
    // A point on the wave where the studio picks this very paint call (the wave's box is wider than the wave).
    let point = null;
    const [x0, y0, x1, y1] = wave.bbox;
    for (let i = 1; i < 9 && !point; i++) {
      for (let j = 1; j < 9 && !point; j++) {
        const x = x0 + ((x1 - x0) * i) / 9;
        const y = y0 + ((y1 - y0) * j) / 9;
        const info = await page.evaluate(([ms, px, py]) => window.vv.inspectElement(ms, px, py), [waveT * 1000, x, y]);
        if (info?.op && info.op.index === wave.index) point = { x, y };
      }
    }
    assert(point, 'the studio does not pick the wave at any point of it');
    const from = f.at(point.x, point.y);
    await dragTo(from, f.at(point.x + 120, point.y));
    await waitFor(() => (htmlAsset().render?.opOffsets ?? []).length > 0, 'the wave move to be saved', 30000);
    await studio.getByTestId('studio-close').click();
    await sleep(1200);
  });

  await step('the wave itself moved by 120 px in its scene', async () => {
    const now = (await opsAt(waveT)).find((o) => o.index === wave.index);
    assert(now, 'the wave is no longer drawn');
    const moved = Math.round(now.bbox[0] - wave.bbox[0]);
    assert(Math.abs(moved - 120) <= 4, `the wave moved ${moved} px, expected 120`);
    // The move is kept with the wave's identity and the stretch where it is the same wave: it ends where the scene does
    // (the "Stretching" scene starts at 6 s in the FTIR animation).
    const saved = htmlAsset().render.opOffsets.find((o) => o.index === wave.index);
    assert(saved && saved.key === wave.key, `the saved move is not kept with the wave's key: ${JSON.stringify(saved)}`);
    assert(saved.t0 <= 0.5 && saved.t1 >= 5 && saved.t1 <= 6.5, `the wave's move lasts from ${saved.t0} s to ${saved.t1} s, expected to end near 6 s`);
  });

  await step('no other part moved, at any second of the video (only the wave differs)', async () => {
    // The seconds in which this wave is drawn as the same wave (the same number and key), around the pick: the wave may
    // move there. The same number elsewhere is another paint call (here the spring) and must not move.
    const sameWave = (t) => before[t].some((o) => o.index === wave.index && o.key === wave.key);
    const waveRun = new Set([waveT]);
    for (let t = waveT - 1; t >= 0 && sameWave(t); t--) waveRun.add(t);
    for (let t = waveT + 1; t < SECONDS && sameWave(t); t++) waveRun.add(t);
    const violations = [];
    for (let t = 0; t < SECONDS; t++) {
      const was = before[t];
      const now = await opsAt(t);
      assert(was.length === now.length, `at ${t} s the number of paint calls changed (${was.length} to ${now.length})`);
      for (const a of was) {
        if (waveRun.has(t) && a.index === wave.index) continue; // the wave itself
        const b = now.find((o) => o.index === a.index);
        // A paint call without a box (a path2D) is the same only if it is still there and has no box.
        const same = a.bbox ? Boolean(b?.bbox) && a.bbox.every((v, k) => Math.abs(v - b.bbox[k]) < 0.5) : Boolean(b) && !b.bbox;
        if (!same) violations.push({ t, index: a.index, kind: a.kind, text: a.text, from: a.bbox, to: b?.bbox ?? null });
      }
    }
    if (violations.length) {
      const first = violations.slice(0, 4).map((v) => `at ${v.t} s: ${v.kind} #${v.index}${v.text ? ` "${v.text}"` : ''} moved`).join('; ');
      throw new Error(`${violations.length} other parts moved. ${first}`);
    }
  });

  console.log('\nAll part-isolation checks passed.');
} catch (err) {
  failed = true;
  console.error(err);
  if (stderrText) console.error(`--- app stderr (last part) ---
${stderrText}`);
} finally {
  await stop();
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (err) {
    console.warn(`could not remove ${work}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
