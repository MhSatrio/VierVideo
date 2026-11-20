// Usability round (Stage 7): the example project, zoom and pan of the preview, full screen, the render window that must
// stay out of the taskbar, "Edit element" (code and studio), and the code saved in the project across a restart.
// Drives the real Electron app over CDP. Run:  npm run e2e:usability   (needs ffprobe on PATH; Windows only)
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
const CDP_PORT = 9351;
const FTIR_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'ftir-60s.html');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e7-'));
const userData = path.join(work, 'user-data');
const MARK = '<!-- vv usability test edit -->';

let proc = null;
let browser = null;
let page = null;
let projectDir = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const readDoc = () => JSON.parse(fs.readFileSync(path.join(projectDir, 'project.vvproj.json'), 'utf8'));
const clipsOn = (track) => readDoc().timeline.tracks.find((t) => t.id === track).clips;
const htmlAssetFile = () => {
  const a = readDoc().assets.find((x) => x.kind === 'html');
  return { asset: a, file: path.join(projectDir, a.file) };
};

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

async function launch(autoExample) {
  const busy = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  if (busy) throw new Error(`Port ${CDP_PORT} is already in use by an earlier VierVideo test. Close that Electron window first.`);
  const env = { ...process.env, VV_E2E: '1', VV_USER_DATA: userData };
  if (autoExample) env.VV_AUTO_EXAMPLE = '1';
  else delete env.VV_AUTO_EXAMPLE;
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

/** The screen point of a point of the frame (in frame pixels), for the frame shown by the locator. */
async function screenPoint(frameLocator, fx, fy) {
  const box = await frameLocator.boundingBox();
  const size = await frameLocator.evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight }));
  assert(box && size.w > 0, 'the frame has no size');
  const frameW = Number(await frameLocator.evaluate((el) => getComputedStyle(el).getPropertyValue('--w'))) || 1080;
  const frameH = Number(await frameLocator.evaluate((el) => getComputedStyle(el).getPropertyValue('--h'))) || 1920;
  return { x: box.x + (fx / frameW) * box.width, y: box.y + (fy / frameH) * box.height };
}

/**
 * The windows of the app's process, and whether Windows puts each one in the taskbar. The rule is Windows' own: a
 * visible top-level window is listed unless it is owned by another window or is a tool window (WS_EX_TOOLWINDOW),
 * and WS_EX_APPWINDOW forces it in. Only this process is looked at: other programs must not decide the result.
 */
function taskbarEntries(pid) {
  const script = [
    'Add-Type -AssemblyName UIAutomationClient;',
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class VvWin {',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);',
    '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);',
    '}',
    '"@;',
    '$root = [System.Windows.Automation.AutomationElement]::RootElement;',
    '$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition);',
    `foreach ($w in $wins) { if ($w.Current.ProcessId -eq ${Number(pid)}) {`,
    '  $h = [IntPtr]$w.Current.NativeWindowHandle;',
    '  $owned = [VvWin]::GetWindow($h, 4) -ne [IntPtr]::Zero;', // GW_OWNER = 4
    '  $ex = [VvWin]::GetWindowLong($h, -20);', // GWL_EXSTYLE
    '  $tool = ($ex -band 0x80) -ne 0;', // WS_EX_TOOLWINDOW
    '  $forced = ($ex -band 0x40000) -ne 0;', // WS_EX_APPWINDOW
    '  $visible = [VvWin]::IsWindowVisible($h);',
    '  $taskbar = $visible -and ((-not $owned -and -not $tool) -or $forced);',
    '  $w.Current.Name + " | taskbar=" + $taskbar',
    '} }',
  ].join('\n');
  const file = path.join(work, 'taskbar-check.ps1');
  fs.writeFileSync(file, script, 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 60000 });
  assert(r.status === 0, `window check failed: ${r.stderr}`);
  return r.stdout
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.includes(' | taskbar='))
    .map((l) => {
      const [name, flag] = l.split(' | taskbar=');
      return { name: name.trim(), taskbar: flag.trim() === 'True' };
    });
}

/**
 * A real key press, as a user makes it: the app's window is brought to the front and Windows delivers the key.
 * (Keys sent over the DevTools protocol do not reach the application's key handling in this build.)
 */
function realKey(keys) {
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate(${proc.pid}); Start-Sleep -Milliseconds 500; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
  assert(r.status === 0, `sending ${keys} failed: ${r.stderr}`);
}

let failed = false;
try {
  console.log('VierVideo usability round (example, zoom, full screen, edit element)');
  await launch(true);

  await step('on the first start the example project opens by itself', async () => {
    await page.locator('.app').waitFor({ timeout: 60000 });
    const state = await page.evaluate(() => window.vv.state());
    projectDir = state.dir;
    assert(/^Example - FTIR spectroscopy/.test(state.doc.name), `project name: ${state.doc.name}`);
  });

  await step('the example has the animation, a chime and a drone, narration, a caption and the logo', async () => {
    const doc = readDoc();
    const html = clipsOn('html');
    assert(html.length === 1 && html[0].start === 0 && html[0].duration === 60, `html clip: ${JSON.stringify(html)}`);
    const music = clipsOn('music');
    assert(music.length === 2 && music.some((c) => c.name === 'Chime (sound effect)') && music.some((c) => c.name === 'Drone (background)'), `music: ${JSON.stringify(music)}`);
    assert(clipsOn('text').length === 1 && clipsOn('visual').length === 1, 'the caption or the logo is missing');
    assert(doc.narration && doc.narration.segments.length === 3, 'the narration script is not in the example');
    assert(doc.assets.some((a) => a.kind === 'html' && a.name === 'FTIR spectroscopy.html'), 'the animation is not named in the library');
  });

  await step('the preview zooms with Ctrl + wheel, pans with the wheel, and goes back with Fit', async () => {
    const frame = page.getByTestId('composition-frame');
    const stage = page.getByTestId('zoom-stage');
    assert((await stage.getAttribute('data-zoom')) === '1.000', 'the preview does not start at fit');
    const c = await screenPoint(frame, 540, 960);
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -300);
    await page.keyboard.up('Control');
    await waitFor(async () => Number(await stage.getAttribute('data-zoom')) > 1.2, 'the zoom to grow');
    const before = Number(await stage.getAttribute('data-pan-x'));
    await page.mouse.wheel(-120, 0);
    await waitFor(async () => Number(await stage.getAttribute('data-pan-x')) !== before, 'the pan to move');
    await page.getByTestId('zoom-fit').click();
    await waitFor(async () => (await stage.getAttribute('data-zoom')) === '1.000' && (await stage.getAttribute('data-pan-x')) === '0', 'Fit to reset the view');
  });

  await step('100% shows the frame at its real pixel size, and the zoom label says so', async () => {
    await page.getByTestId('zoom-actual').click();
    await waitFor(async () => (await page.getByTestId('zoom-label').textContent()).trim() === '100%', 'the label to read 100%');
    await page.getByTestId('zoom-fit').click();
  });

  await step('zoom keeps the point under the pointer, so a layer is still picked after zooming in', async () => {
    const frame = page.getByTestId('composition-frame');
    const stage = page.getByTestId('zoom-stage');
    const caption = clipsOn('text')[0];
    const p = await screenPoint(frame, caption.x + caption.w / 2, caption.y + caption.h / 2);
    await page.mouse.move(p.x, p.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -300);
    await page.keyboard.up('Control');
    await waitFor(async () => Number(await stage.getAttribute('data-zoom')) > 1.2, 'the zoom to grow');
    // The caption is still under the pointer after zooming (zoom is about the pointer): click the same spot.
    await page.mouse.click(p.x, p.y);
    await page.getByLabel('Text content').waitFor({ timeout: 15000 });
    await page.getByTestId('zoom-fit').click();
  });

  await step('full screen: F11 enters it, and Escape leaves it (real key presses; no need to close the project)', async () => {
    const fullScreenNow = async () => (await page.evaluate(() => window.vv.e2eWindows())).some((w) => w.fullScreen);
    assert(!(await fullScreenNow()), 'the window starts in full screen');
    realKey('{F11}');
    await waitFor(fullScreenNow, 'the window to be full screen after F11');
    await waitFor(() => page.getByTestId('fullscreen-exit').isVisible(), 'the Exit full screen button');
    realKey('{ESC}');
    await waitFor(async () => !(await fullScreenNow()), 'the window to leave full screen after Escape');
    await waitFor(async () => !(await page.getByTestId('fullscreen-exit').isVisible()), 'the Exit button to go');
  });

  await step('the render window does not appear in the taskbar (the main window is found, the render window is not)', async () => {
    const entries = taskbarEntries(proc.pid);
    console.log(`       windows of this program: ${JSON.stringify(entries)}`);
    assert(entries.some((e) => e.name === 'VierVideo' && e.taskbar), 'the check does not list the VierVideo window in the taskbar, so its result means nothing');
    const extra = entries.filter((e) => e.taskbar && e.name !== 'VierVideo');
    assert(extra.length === 0, `these windows of the app appear in the taskbar: ${extra.map((e) => e.name).join('; ')}`);
  });

  await step('right-click the preview: "Edit element" offers the code and the studio', async () => {
    const frame = page.getByTestId('composition-frame');
    const c = await screenPoint(frame, 540, 960);
    await page.mouse.click(c.x, c.y, { button: 'right' });
    const menu = page.getByTestId('edit-element-menu');
    await menu.waitFor();
    assert((await menu.textContent()).includes('Edit element'), 'the menu has no title');
    assert(await page.getByTestId('edit-code').isEnabled(), 'Show code is disabled');
    assert(await page.getByTestId('open-studio').isEnabled(), 'Open studio is disabled');
  });

  await step('"Show code" opens the animation code in the right panel, and Save puts the change in the project', async () => {
    await page.getByTestId('edit-code').click();
    const text = page.getByTestId('code-text');
    await text.waitFor();
    await waitFor(async () => (await text.inputValue()).includes('<'), 'the code to load');
    const original = await text.inputValue();
    assert(original.length > 1000, `the code is only ${original.length} characters`);
    await text.fill(original + '\n' + MARK);
    await page.getByTestId('code-save').click();
    await waitFor(async () => (await page.getByTestId('code-state').textContent()).trim() === 'Saved', 'the code to be saved');
    const { asset, file } = htmlAssetFile();
    assert(asset.edited === true, 'the asset is not marked as edited');
    assert(fs.readFileSync(file, 'utf8').includes(MARK), 'the saved file does not hold the change');
    assert(fs.readFileSync(file + '.original', 'utf8') === fs.readFileSync(FTIR_FIXTURE, 'utf8'), 'the original copy is not kept');
  });

  await step('the studio: click the animation to see its element, and add a box', async () => {
    await page.getByTestId('zoom-stage').waitFor();
    // The studio opens over the window; the code editor stays in the inspector behind it.
    const frame = page.getByTestId('composition-frame');
    const c = await screenPoint(frame, 540, 960);
    await page.mouse.click(c.x, c.y, { button: 'right' });
    await page.getByTestId('open-studio').click();
    const studio = page.getByTestId('studio');
    await studio.waitFor();
    const sframe = studio.getByTestId('composition-frame');
    await sframe.waitFor();
    const p = await screenPoint(sframe, 540, 860);
    await page.mouse.click(p.x, p.y);
    const info = page.getByTestId('element-info');
    await info.waitFor({ timeout: 30000 });
    const tag = await info.getAttribute('data-tag');
    assert(tag && /^[a-z0-9-]+$/.test(tag), `no element tag: ${tag}`);
    assert((await page.getByTestId('element-selector').textContent()).length > 0, 'no element path');
    const shapesBefore = clipsOn('visual').filter((c) => c.kind === 'shape').length;
    await studio.getByTestId('studio-add-rect').click();
    await waitFor(async () => clipsOn('visual').filter((c) => c.kind === 'shape').length === shapesBefore + 1, 'the box to be added');
    await page.getByTestId('studio-close').click();
    await waitFor(async () => (await page.getByTestId('studio').count()) === 0, 'the studio to close');
  });

  await step('the project, and the saved code, survive a restart; the example is opened again, not copied', async () => {
    await page.locator('.topbar').getByRole('button', { name: 'Close project' }).click();
    await page.getByTestId('open-example').waitFor();
    await stop();
    await launch(true);
    await page.getByTestId('open-example').waitFor({ timeout: 60000 });
    await page.getByTestId('open-example').click();
    await page.locator('.app').waitFor({ timeout: 60000 });
    const state = await page.evaluate(() => window.vv.state());
    assert(state.dir === projectDir, `the example was copied: ${state.dir}`);
    assert(state.doc.name === 'Example - FTIR spectroscopy', `name: ${state.doc.name}`);
    assert(htmlAssetFile().asset.edited === true, 'the edit was lost');
    assert(fs.readFileSync(htmlAssetFile().file, 'utf8').includes(MARK), 'the saved code was lost');
  });

  await step('"Restore original" puts the animation back as it was imported', async () => {
    const frame = page.getByTestId('composition-frame');
    const c = await screenPoint(frame, 540, 960);
    await page.mouse.click(c.x, c.y, { button: 'right' });
    await page.getByTestId('edit-code').click();
    await page.getByTestId('code-restore').click();
    await waitFor(async () => htmlAssetFile().asset.edited === false, 'the restore');
    assert(fs.readFileSync(htmlAssetFile().file, 'utf8') === fs.readFileSync(FTIR_FIXTURE, 'utf8'), 'the animation is not the original');
  });

  console.log('\nAll usability checks passed.');
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
