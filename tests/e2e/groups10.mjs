// Canvas parts in the studio (feedback round 10): a drag on empty space selects the parts it touches (the FTIR title and
// the wave), Ctrl+G groups them, the group moves and resizes as one, and a press on the visible left half of a centred
// title picks that title. The title's drag follows the pointer. Drives the real Electron app over CDP (Windows); Ctrl+G is a
// real key press (SendKeys), since keys sent over CDP do not reach the app. Run:  node tests/e2e/groups10.mjs
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
const CDP_PORT = 9373;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e-groups10-'));
const userData = path.join(work, 'user-data');
const projects = path.join(work, 'projects');
const FTIR =
  process.env.VV_FTIR_HTML || path.join(os.homedir(), 'Downloads', 'FTIR Spectroscopy in 60 Seconds _ Vier Apparatus (1).html');
const T = 4600; // ms: the title and the wave are on screen

let proc = null;
let appStderr = '';
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
  proc.stderr.on('data', (d) => { appStderr = (appStderr + d.toString()).slice(-6000); });
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
  page.on('crash', () => console.error('[debug] renderer crashed'));
  page.on('close', () => console.error('[debug] page closed'));
  page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) console.error('[debug] navigated: ' + fr.url()); });
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

/** A real key press (Windows SendKeys), sent to the app's window. */
function realKey(keys) {
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate(${proc.pid}); Start-Sleep -Milliseconds 500; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
  assert(r.status === 0, `sending ${keys} failed: ${r.stderr}`);
}

const opsAt = (ms) => page.evaluate((t) => window.vv.e2eOps(t), ms);
const titleOf = (ops) => ops.find((o) => o.kind === 'text' && o.text === 'FTIR');
const waveOf = (ops) => ops.filter((o) => o.kind === 'stroke' && o.bbox && o.bbox[2] - o.bbox[0] > 900).sort((a, b) => b.bbox[2] - b.bbox[0] - (a.bbox[2] - a.bbox[0]))[0];

/** The frame of the studio on screen: frame pixels (1080 x 1920) to screen points. */
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
let title0 = null;
let wave0 = null;
try {
  console.log('VierVideo canvas parts in the studio (feedback round 10)');
  await launch();

  await step('a project with the FTIR animation from Downloads is open', async () => {
    await page.waitForSelector('.recent-item button.open, .app', { timeout: 60000 }).catch(() => {});
    await page.evaluate((p) => window.vv.createProject(p), { parentDir: projects, name: 'Groups check', settings: { aspect: '9:16', fps: 30, durationSec: 60 } });
    await page.evaluate(() => window.vv.closeProject());
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.recent-item button.open').first().click({ timeout: 60000 });
    await page.locator('.app').waitFor({ timeout: 60000 });
    projectDir = (await page.evaluate(() => window.vv.state())).dir;
    await page.evaluate((f) => window.vv.e2eSetPicks({ files: [f] }), FTIR);
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await waitFor(() => readDoc().assets.some((a) => a.kind === 'html'), 'the FTIR file to be imported', 60000);
    await page.locator('.asset-card', { hasText: 'FTIR Spectroscopy' }).first().click();
    await page.getByTestId('add-html').click();
    await waitFor(() => htmlClips().length === 1, 'the animation clip', 30000);
    await page.locator('.asset-card', { hasText: 'FTIR Spectroscopy' }).first().click();
    await page.locator('input.scrubber').fill(String(T));
    await sleep(1500);
    title0 = titleOf(await opsAt(T));
    wave0 = waveOf(await opsAt(T));
    assert(title0 && wave0, `the title or the wave is not drawn at ${T} ms`);
  });

  await step('the visible left half of the centred title picks the title (its box is around its letters)', async () => {
    // The title is centred on x = 540: its letters start to the left of that. The left part of the letters is a press point.
    const left = title0.bbox[0];
    const info = await page.evaluate(([ms, x, y]) => window.vv.inspectElement(ms, x, y), [T, left + 40, (title0.bbox[1] + title0.bbox[3]) / 2]);
    assert(info?.op && info.op.text === 'FTIR', `the press at x=${Math.round(left + 40)} picked ${info?.op ? info.op.text : info?.tag ?? 'nothing'}`);
  });

  const studio = page.getByTestId('studio');
  await step('the studio opens, and snapping is turned off for the exact checks', async () => {
    const c = await page.getByTestId('composition-frame').boundingBox();
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2, { button: 'right' });
    await page.getByTestId('open-studio').click();
    await studio.waitFor();
    await studio.getByTestId('grid-snap').uncheck();
  });

  await step('a drag on empty space around the title and the wave selects both parts', async () => {
    // The parts are listed once the render engine has drawn the frame: wait for the list before selecting.
    await studio.getByTestId('part-row').first().waitFor({ timeout: 30000 });
    const f = await frameMap(studio);
    await dragTo(f.at(20, 650), f.at(1060, 1560));
    await waitFor(async () => (await studio.locator('.layer-row.selected').count()) >= 2, 'the title and the wave to be selected');
    await studio.getByTestId('selection-info').waitFor({ timeout: 5000 });
  });

  await step('Ctrl+G (a real key press) groups the selected parts', async () => {
    realKey('^g');
    await waitFor(() => (htmlAsset().render?.partGroups ?? []).length >= 2, 'the parts to be grouped', 30000);
    const groups = htmlAsset().render.partGroups;
    assert(new Set(groups.map((g) => g.group)).size === 1, 'the grouped parts do not share one group');
  });

  await step('moving the group by 60 px moves the title and the wave together', async () => {
    const f = await frameMap(studio);
    // Press on the title (its centre), drag right by 60 px.
    const cx = (title0.bbox[0] + title0.bbox[2]) / 2;
    const cy = (title0.bbox[1] + title0.bbox[3]) / 2;
    await dragTo(f.at(cx, cy), f.at(cx + 60, cy));
    await waitFor(async () => {
      const t = titleOf(await opsAt(T));
      return t && Math.abs(t.bbox[0] - (title0.bbox[0] + 60)) < 3;
    }, 'the title to move by 60 px', 60000);
    const now = await opsAt(T);
    const w = waveOf(now);
    assert(Math.abs(w.bbox[0] - (wave0.bbox[0] + 60)) < 3, `the wave is at ${w.bbox[0]}, expected ${wave0.bbox[0] + 60}`);
  });

  await step('the group resizes: the top-left handle by (-40, -40) makes the title and the wave bigger', async () => {
    const before = titleOf(await opsAt(T));
    const beforeWave = waveOf(await opsAt(T));
    const handle = await studio.getByTestId('layer-handle-nw').boundingBox();
    const f = await frameMap(studio);
    const from = [handle.x + handle.width / 2, handle.y + handle.height / 2];
    const to = [from[0] - (f.box.width * 40) / 1080, from[1] - (f.box.height * 40) / 1920];
    await dragTo(from, to);
    await waitFor(async () => {
      const t = titleOf(await opsAt(T));
      return t && t.bbox[2] - t.bbox[0] > before.bbox[2] - before.bbox[0] + 10;
    }, 'the title to grow', 60000);
    const after = titleOf(await opsAt(T));
    const afterWave = waveOf(await opsAt(T));
    assert(afterWave.bbox[2] - afterWave.bbox[0] > beforeWave.bbox[2] - beforeWave.bbox[0] + 10, 'the wave did not grow with the group');
    // The group's box is the union of its items. The corner opposite the handle stays; each item keeps its place inside the
    // box, so the title's right edge goes where the box maps it (not where it was).
    const ux0 = Math.min(before.bbox[0], beforeWave.bbox[0]);
    const ux1 = Math.max(before.bbox[2], beforeWave.bbox[2]);
    const vx0 = Math.min(after.bbox[0], afterWave.bbox[0]);
    const vx1 = Math.max(after.bbox[2], afterWave.bbox[2]);
    assert(Math.abs(vx1 - ux1) < 3, `the box's right side moved from ${ux1} to ${vx1}; the opposite corner should stay`);
    const expected = vx0 + ((before.bbox[2] - ux0) * (vx1 - vx0)) / (ux1 - ux0);
    assert(Math.abs(after.bbox[2] - expected) < 3, `the title's right edge is at ${after.bbox[2]}, expected ${expected.toFixed(1)} from the box`);
    const expectedLeft = vx0 + ((before.bbox[0] - ux0) * (vx1 - vx0)) / (ux1 - ux0);
    assert(Math.abs(after.bbox[0] - expectedLeft) < 3, `the title's left edge is at ${after.bbox[0]}, expected ${expectedLeft.toFixed(1)} from the box`);
  });

  await step('with snapping on, a drag follows the pointer (snapping only takes an edge that is near a grid line)', async () => {
    await studio.getByTestId('grid-snap').check();
    const f = await frameMap(studio);
    const t0 = titleOf(await opsAt(T));
    const cx = (t0.bbox[0] + t0.bbox[2]) / 2;
    const cy = (t0.bbox[1] + t0.bbox[3]) / 2;
    await dragTo(f.at(cx, cy), f.at(cx + 100, cy - 150));
    await sleep(2500);
    const t1 = titleOf(await opsAt(T));
    const dx = t1.bbox[0] - t0.bbox[0];
    const dy = t1.bbox[1] - t0.bbox[1];
    // Snapping moves an edge only when it is within 6 screen pixels of a grid line, so the drag is exact except for that
    // pull: 6 screen pixels is 6 x 1080 / (the frame's width on screen) frame pixels. (The old snap moved every drag to the
    // grid, up to half a cell, however far the pointer went.)
    const tol = (6 * 1080) / f.box.width + 2;
    console.log(`       snap tolerance here: ${tol.toFixed(1)} frame px; the title moved ${Math.round(dx)}, ${Math.round(dy)}`);
    assert(Math.abs(dx - 100) <= tol, `the drag moved the title ${Math.round(dx)} px across, expected 100 within ${tol.toFixed(1)}`);
    assert(Math.abs(dy + 150) <= tol, `the drag moved the title ${Math.round(dy)} px down, expected -150 within ${tol.toFixed(1)}`);
  });

  console.log('\nAll canvas-part checks passed.');
} catch (err) {
  failed = true;
  console.error(err);
  if (appStderr) console.error('--- app stderr (last part) ---\n' + appStderr);
} finally {
  await stop();
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (err) {
    console.warn(`could not remove ${work}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
