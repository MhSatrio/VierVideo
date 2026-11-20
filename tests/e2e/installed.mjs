// Installed-program test (Stage 6). Installs the built VierVideo-Setup exe silently into a temp folder, then runs
// the INSTALLED program with no FFmpeg and no Python on its PATH and with an empty LOCALAPPDATA, which is what a
// clean machine looks like. It checks that the bundled FFmpeg is used for an export, that the narration engine is
// reported as missing (with a message, not a crash), and that the silent uninstall removes the program and shortcuts.
// Run:  npm run dist:win && node tests/e2e/installed.mjs     (Windows only; ffprobe is used from the normal PATH)
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PRODUCT = pkg.build.productName;
const OUT = process.env.VV_OUT || path.join(os.homedir(), `${PRODUCT}-release`);
const INSTALLER = process.env.VV_INSTALLER || path.join(OUT, `${PRODUCT}-Setup-${pkg.version}.exe`);
const CDP_PORT = 9349;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e6-'));
const INSTALL_DIR = path.join(work, 'install');
const APP_EXE = path.join(INSTALL_DIR, `${PRODUCT}.exe`);
const UNINSTALL = path.join(INSTALL_DIR, `Uninstall ${PRODUCT}.exe`);
const RES = path.join(INSTALL_DIR, 'resources');
const parent = path.join(work, 'projects');
const userData = path.join(work, 'user-data');
const localAppData = path.join(work, 'localappdata');
const PROJECT_DIR = path.join(parent, 'Installed check');
const FTIR = path.join(ROOT, 'tests', 'fixtures', 'ftir-60s.html');
const SCRIPT = path.join(ROOT, 'tests', 'fixtures', 'narration-sample.txt');
// Only the Windows folders: no FFmpeg, no Python, no winget packages.
const SYSTEM_ROOT = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
const CLEAN_PATH = `${SYSTEM_ROOT}\\System32;${SYSTEM_ROOT}`;

let proc = null;
let browser = null;
let page = null;
let installed = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const readDoc = () => JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.vvproj.json'), 'utf8'));

async function waitFor(pred, what, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(300);
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

function startMenuShortcuts() {
  const root = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const hits = [];
  const walk = (dir, depth) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (e.name.toLowerCase() === `${PRODUCT.toLowerCase()}.lnk`) hits.push(p);
    }
  };
  walk(root, 0);
  return hits;
}

async function install() {
  assert(fs.existsSync(INSTALLER), `installer not found: ${INSTALLER}. Run "npm run dist:win" first.`);
  const r = spawnSync(INSTALLER, ['/S', `/D=${INSTALL_DIR}`], { timeout: 900000 });
  assert(r.status === 0, `the installer stopped with exit code ${r.status}`);
  await waitFor(() => fs.existsSync(APP_EXE) && fs.existsSync(UNINSTALL), 'the program files to appear', 60000);
  installed = true;
}

async function launch() {
  const busy = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  if (busy) throw new Error(`Port ${CDP_PORT} is already in use by an earlier VierVideo test. Close that Electron window first.`);
  const env = { ...process.env, VV_E2E: '1', VV_USER_DATA: userData, LOCALAPPDATA: localAppData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VIERVIDEO_FFMPEG;
  delete env.VIERVIDEO_PYTHON;
  // Windows environment names are not case-sensitive, but the object keys are: set the one that exists.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = CLEAN_PATH;
  fs.mkdirSync(localAppData, { recursive: true });
  proc = spawn(APP_EXE, [`--remote-debugging-port=${CDP_PORT}`], { stdio: ['ignore', 'ignore', 'pipe'], env, cwd: INSTALL_DIR });
  proc.stderr.on('data', (d) => {
    if (process.env.VV_DEBUG) process.stderr.write(String(d));
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      break;
    } catch {
      await sleep(400);
    }
  }
  assert(browser, 'could not connect to the installed program over CDP');
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

function uninstall() {
  const r = spawnSync(UNINSTALL, ['/S'], { timeout: 300000 });
  assert(r.status === 0 || r.status === null, `the uninstaller stopped with exit code ${r.status}`);
  // The silent uninstaller copies itself away and finishes in the background: wait for the program to be gone.
  return waitFor(() => !fs.existsSync(APP_EXE) && startMenuShortcuts().length === 0, 'the program and its shortcuts to be removed', 120000);
}

/**
 * A real key press, as a user makes it: the program's window is brought to the front and Windows delivers the key.
 * (Keys sent over the DevTools protocol do not reach the program's key handling in this build.)
 */
function realKey(keys) {
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate(${proc.pid}); Start-Sleep -Milliseconds 500; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
  assert(r.status === 0, `sending ${keys} failed: ${r.stderr}`);
}

const setPicks = (p) => page.evaluate((x) => window.vv.e2eSetPicks(x), p);
async function waitStatus(re, timeout = 900000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.status-line')?.textContent ?? ''), re.source, { timeout });
}

let failed = false;
const measured = {};
try {
  console.log(`VierVideo installed-program test (${path.basename(INSTALLER)})`);
  assert(process.platform === 'win32', 'this test is for Windows');

  await step('the silent installer puts the program, the bundled FFmpeg and the narration files in the folder', async () => {
    await install();
    const expected = [
      APP_EXE,
      path.join(RES, 'app.asar'),
      path.join(RES, 'ffmpeg', 'ffmpeg.exe'),
      path.join(RES, 'ffmpeg', 'NOTICE.txt'),
      path.join(RES, 'tts', 'worker.py'),
      path.join(RES, 'tts', 'config.json'),
      path.join(RES, 'tts', 'pronunciations.json'),
      path.join(RES, 'tts', 'requirements.txt'),
      path.join(RES, 'tts', 'setup-narration.ps1'),
      // The example project's files (the animation is included unless VV_NO_EXAMPLE_ANIMATION=1 was used to build)
      path.join(RES, 'examples', 'narration-sample.txt'),
      path.join(RES, 'examples', 'icon.svg'),
    ];
    assert(fs.existsSync(path.join(RES, 'examples', 'ftir-60s.html')) || process.env.VV_NO_EXAMPLE_ANIMATION === '1', 'the example animation is not in the install (build without VV_NO_EXAMPLE_ANIMATION=1)');
    const missing = expected.filter((f) => !fs.existsSync(f));
    assert(missing.length === 0, `missing from the install: ${missing.map((f) => path.relative(INSTALL_DIR, f)).join(', ')}`);
    assert(startMenuShortcuts().length > 0, 'the Start menu shortcut was not created');
  });

  await step('the installed program starts with no FFmpeg or Python on its PATH', async () => {
    await launch();
    await page.locator('.start').waitFor({ timeout: 60000 });
  });

  await step('the bundled FFmpeg is the one used (source "bundled", inside the install folder)', async () => {
    const info = await page.evaluate(() => window.vv.ffmpegStatus());
    measured.ffmpeg = info;
    assert(info && info.source === 'bundled', `FFmpeg source: ${JSON.stringify(info)}`);
    assert(info.path.toLowerCase().startsWith(INSTALL_DIR.toLowerCase()), `FFmpeg is outside the install folder: ${info.path}`);
  });

  await step('full screen works in the installed program: F11 enters it, Escape leaves it (real key presses)', async () => {
    const fullScreenNow = async () => (await page.evaluate(() => window.vv.e2eWindows())).some((w) => w.fullScreen);
    assert(!(await fullScreenNow()), 'the window starts in full screen');
    realKey('{F11}');
    await waitFor(fullScreenNow, 'the installed window to be full screen after F11', 15000);
    realKey('{ESC}');
    await waitFor(async () => !(await fullScreenNow()), 'the installed window to leave full screen after Escape', 15000);
  });

  await step('the narration engine is reported as not installed (no crash)', async () => {
    const tts = await page.evaluate(() => window.vv.ttsStatus());
    assert(tts && tts.python === null && tts.ready === false, `narration status: ${JSON.stringify(tts)}`);
  });

  await step('create a project, make it 2 s, add the FTIR animation', async () => {
    await setPicks({ folder: parent });
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill('Installed check');
    await page.getByRole('button', { name: 'Choose folder' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.locator('.app').waitFor();
    await page.locator('.timeline-tools').getByLabel('Timeline duration in seconds').fill('2');
    await page.locator('.timeline-tools').getByRole('button', { name: 'Set' }).click();
    await page.waitForFunction(() => (document.querySelector('.timeline-tools')?.closest('.panel')?.textContent ?? '').includes('2 s'));
    await setPicks({ files: [FTIR, SCRIPT] });
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await page.locator('.asset-card', { hasText: 'ftir-60s.html' }).waitFor();
    await page.locator('.asset-card', { hasText: 'narration-sample.txt' }).waitFor();
    await page.locator('.asset-card', { hasText: 'ftir-60s.html' }).click();
    await page.getByTestId('add-html').click();
    await page.locator('[data-track="html"] .tl-clip').waitFor();
  });

  await step('export the 2 s timeline with the bundled FFmpeg', async () => {
    await page.getByTestId('export-timeline').click();
    await waitStatus(/Exported timeline-.*no sound/);
    const rec = readDoc().renders.find((r) => r.kind === 'timeline');
    assert(rec, 'no render record was written');
    const file = path.join(PROJECT_DIR, rec.file);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' });
    assert(probe.status === 0, `ffprobe could not read the export: ${probe.stderr}`);
    const j = JSON.parse(probe.stdout);
    const v = j.streams[0];
    assert(v.codec_name === 'h264' && v.width === 1080 && v.height === 1920, `video: ${JSON.stringify(v)}`);
    assert(Math.abs(Number(j.format.duration) - 2) < 0.15, `duration ${j.format.duration}`);
    measured.exportBytes = rec.bytes;
  });

  await step('the narration panel says the engine is not installed, and how to install it', async () => {
    await page.locator('.asset-card', { hasText: 'narration-sample.txt' }).click();
    await page.getByText('narration engine (Python with Kokoro) was not found').waitFor({ timeout: 30000 });
    await page.getByText('setup-narration.ps1').first().waitFor({ timeout: 5000 });
  });

  await step('close the project and quit the program', async () => {
    await page.locator('.topbar').getByRole('button', { name: 'Close project' }).click();
    await page.locator('.start').waitFor();
    await stop();
  });

  await step('the silent uninstaller removes the program and its Start menu shortcut', async () => {
    await uninstall();
    installed = false;
    assert(!fs.existsSync(APP_EXE), 'the program is still there after uninstall');
  });

  console.log(`\nMeasured: ${JSON.stringify(measured)}`);
  console.log('All installed-program checks passed.');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await stop();
  if (installed) {
    try {
      uninstall();
    } catch (err) {
      console.warn(`could not uninstall the test copy: ${err.message}`);
    }
  }
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (err) {
    console.warn(`could not remove ${work}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
