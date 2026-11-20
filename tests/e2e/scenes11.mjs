// A moved part stays in its own scene (feedback round 11). The Stretching spring is moved in the studio; its stretch of the
// video must end at the scene cut, so the Bending springs (which the drawing reuses under the same paint-call number and
// kind) are not moved. Every second of the video is compared with the state before the move. Drives the real Electron app
// over CDP (Windows); the FTIR file is imported from Downloads (or VV_FTIR_HTML) into a new project. Run:
//   node tests/e2e/scenes11.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain ESM module (no types needed in a test script)
import { sameScene } from '../../shared/project-format.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const electronExe = require('electron');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDP_PORT = 9375;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e-scenes11-'));
const userData = path.join(work, 'user-data');
const projects = path.join(work, 'projects');
const FTIR =
  process.env.VV_FTIR_HTML || path.join(os.homedir(), 'Downloads', 'FTIR Spectroscopy in 60 Seconds _ Vier Apparatus (1).html');
const SECONDS = 60;
const SPRING_T = 7; // seconds: the Stretching spring is on screen

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
  proc.stderr.on('data', (d) => {
    stderrText = (stderrText + d.toString()).slice(-4000);
  });
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
/** The Stretching spring: the dark stroke under paint-call number `index`. */
const springKey = 'stroke|#231f20|';

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

let failed = false;
let spring = null;
let before = [];
try {
  console.log('VierVideo: a moved spring stays in its own scene (feedback round 11)');
  await launch();

  await step('a new project is made, and the FTIR file from Downloads is imported into it', async () => {
    await page.waitForSelector('.recent-item button.open, .app', { timeout: 60000 }).catch(() => {});
    await page.evaluate((p) => window.vv.createProject(p), { parentDir: projects, name: 'Scenes check 11', settings: { aspect: '9:16', fps: 30, durationSec: SECONDS } });
    await page.evaluate(() => window.vv.closeProject());
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.recent-item button.open').first().click({ timeout: 60000 });
    await page.locator('.app').waitFor({ timeout: 60000 });
    projectDir = (await page.evaluate(() => window.vv.state())).dir;
    await page.evaluate((f) => window.vv.e2eSetPicks({ files: [f] }), FTIR);
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await waitFor(() => readDoc().assets.some((a) => a.kind === 'html'), 'the FTIR file to be imported', 60000);
  });

  await step('the animation is added to the timeline', async () => {
    await page.locator('.asset-card', { hasText: 'FTIR Spectroscopy' }).first().click();
    await page.getByTestId('add-html').click();
    await waitFor(() => htmlClips().length === 1, 'the animation clip', 30000);
    await page.locator('.asset-card', { hasText: 'FTIR Spectroscopy' }).first().click();
    await sleep(1500);
  });

  await step('the Stretching spring is found at 7 s', async () => {
    const ops = await opsAt(SPRING_T);
    spring = ops.find((o) => o.kind === 'stroke' && o.key === springKey && o.bbox && o.bbox[2] - o.bbox[0] > 200 && o.bbox[2] - o.bbox[0] < 500);
    assert(spring, `no dark spring of 200 to 500 px at ${SPRING_T} s`);
    console.log(`       spring: paint call #${spring.index} at ${SPRING_T} s, box ${spring.bbox.map((v) => Math.round(v)).join(', ')}`);
  });

  await step('the state of every second of the video is recorded before the move', async () => {
    before = [];
    for (let t = 0; t < SECONDS; t++) before.push(await opsAt(t));
  });

  await step('the spring is moved 60 px to the right in the studio, at 7 s', async () => {
    await page.locator('input.scrubber').fill(String(SPRING_T * 1000));
    await sleep(1200);
    const c = await page.getByTestId('composition-frame').boundingBox();
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2, { button: 'right' });
    await page.getByTestId('open-studio').click();
    const studio = page.getByTestId('studio');
    await studio.waitFor();
    await studio.getByTestId('grid-snap').uncheck();
    const f = await frameMap(studio);
    let point = null;
    const [x0, y0, x1, y1] = spring.bbox;
    for (let i = 1; i < 9 && !point; i++) {
      for (let j = 1; j < 5 && !point; j++) {
        const x = x0 + ((x1 - x0) * i) / 9;
        const y = y0 + ((y1 - y0) * j) / 5;
        const info = await page.evaluate(([ms, px, py]) => window.vv.inspectElement(ms, px, py), [SPRING_T * 1000, x, y]);
        if (info?.op && info.op.index === spring.index && info.op.key === springKey) point = { x, y };
      }
    }
    assert(point, 'the studio does not pick the spring at any point of it');
    await dragTo(f.at(point.x, point.y), f.at(point.x + 60, point.y));
    await waitFor(() => (htmlAsset().render?.opOffsets ?? []).length > 0, 'the spring move to be saved', 60000);
    await studio.getByTestId('studio-close').click();
    await sleep(1200);
  });

  await step('the saved move ends at the scene cut (not in the Bending scene that follows)', async () => {
    const saved = htmlAsset().render.opOffsets.find((o) => o.index === spring.index && o.key === springKey);
    assert(saved, `no saved move for the spring: ${JSON.stringify(htmlAsset().render.opOffsets)}`);
    console.log(`       saved stretch: ${saved.t0.toFixed(2)} s to ${saved.t1.toFixed(2)} s`);
    assert(saved.t0 <= 6.5 && saved.t1 >= 8.5 && saved.t1 < 10.5, `the move lasts from ${saved.t0} s to ${saved.t1} s; it should end at the cut near 10 s`);
  });

  await step('no other part moved, at any second of the video; the Bending springs are not moved', async () => {
    // The seconds in which this spring is the same spring in the same scene (the stretch around 7 s), from the state
    // before the move. Only those seconds may change for the spring itself.
    const sameSpring = (t) => before[t].some((o) => o.index === spring.index && o.key === springKey);
    const run = new Set([SPRING_T]);
    for (let t = SPRING_T - 1; t >= 0 && sameSpring(t) && sameScene(before[t], before[t + 1]); t--) run.add(t);
    for (let t = SPRING_T + 1; t < SECONDS && sameSpring(t) && sameScene(before[t - 1], before[t]); t++) run.add(t);
    const violations = [];
    for (let t = 0; t < SECONDS; t++) {
      const was = before[t];
      const now = await opsAt(t);
      assert(was.length === now.length, `at ${t} s the number of paint calls changed (${was.length} to ${now.length})`);
      for (const a of was) {
        if (run.has(t) && a.index === spring.index && a.key === springKey) continue; // the spring itself, in its own scene
        const b = now.find((o) => o.index === a.index);
        const same = a.bbox ? Boolean(b?.bbox) && a.bbox.every((v, k) => Math.abs(v - b.bbox[k]) < 0.5) : Boolean(b) && !b.bbox;
        if (!same) violations.push({ t, index: a.index, kind: a.kind, text: a.text, key: a.key });
      }
    }
    if (violations.length) {
      const first = violations.slice(0, 5).map((v) => `at ${v.t} s: ${v.key} #${v.index} moved`).join('; ');
      throw new Error(`${violations.length} other parts moved. ${first}`);
    }
  });

  console.log('\nAll scene-cut checks passed.');
} catch (err) {
  failed = true;
  console.error(err);
  if (stderrText) console.error(`--- app stderr (last part) ---\n${stderrText}`);
} finally {
  await stop();
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (err) {
    console.warn(`could not remove ${work}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
