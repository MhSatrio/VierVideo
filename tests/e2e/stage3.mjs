// Stage 3 end-to-end test: narration with the local Kokoro voices (real synthesis, no network).
// Drives the real Electron app over CDP. Needs the vier-tts venv (or VIERVIDEO_PYTHON) with kokoro installed,
// and the Kokoro model in the Hugging Face cache (HF_HOME, default %LOCALAPPDATA%\vier-tts\hf-cache).
// Run:  npm run build && node tests/e2e/stage3.mjs
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
const CDP_PORT = 9343;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e3-'));
const parent = path.join(work, 'projects');
const userData = path.join(work, 'user-data');
const PROJECT_DIR = path.join(parent, 'Narration stage 3');
const SCRIPT = path.join(ROOT, 'tests', 'fixtures', 'narration-sample.txt');
const BAD_PYTHON = path.join(work, 'not-python.exe');
fs.mkdirSync(parent, { recursive: true });
fs.writeFileSync(BAD_PYTHON, 'MZ not python');

let proc = null;
let browser = null;
let page = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const readDoc = () => JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.vvproj.json'), 'utf8'));

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
async function waitStatus(re, timeout = 300000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.status-line')?.textContent ?? ''), re.source, { timeout });
}
/** Sets a range input through React's value setter, the way a user drag does. */
async function setRange(label, value) {
  await page.getByLabel(label, { exact: true }).evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
const statuses = () => page.locator('.seg-row .badge').allInnerTexts();

let failed = false;
try {
  console.log('VierVideo stage 3 end-to-end (narration with local voices)');
  await launch();

  await step('create the project and import the timed narration sample', async () => {
    await page.locator('.start').waitFor();
    await setPicks({ folder: parent });
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill('Narration stage 3');
    await page.getByRole('button', { name: 'Choose folder' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.locator('.app').waitFor();
    await setPicks({ files: [SCRIPT] });
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await page.locator('.asset-card', { hasText: 'narration-sample.txt' }).waitFor();
  });

  await step('the narration engine is found and ready', async () => {
    await page.locator('.asset-card', { hasText: 'narration-sample.txt' }).click();
    await page.getByText('Create narration from this script').waitFor();
    await page.locator('.danger-note', { hasText: 'Narration engine: Python' }).waitFor({ timeout: 60000 });
    await page.getByText('Format: timed. 3 segments.').waitFor();
  });

  await step('the voice list offers the eight voices of the pack', async () => {
    const options = await page.getByLabel('Voice', { exact: true }).locator('option').allInnerTexts();
    assert(options.length === 8, `voices offered: ${options.length}`);
    assert(options.some((o) => o.startsWith('Emma') && o.includes('British English')), 'British voice missing');
  });

  await step('voice preview produces a playable file', async () => {
    await page.getByLabel('Voice', { exact: true }).selectOption('bf_emma');
    await page.getByRole('button', { name: 'Preview' }).click();
    await page.getByLabel('Voice preview').waitFor({ timeout: 180000 });
    const src = await page.getByLabel('Voice preview').getAttribute('src');
    assert(src.startsWith('vvproj://file/audio/previews/'), `preview src: ${src}`);
    const dir = path.join(PROJECT_DIR, 'audio', 'previews');
    assert(fs.existsSync(dir) && fs.readdirSync(dir).length >= 1, 'no preview file was written');
  });

  await step('create the narration: three segments keep their timestamps', async () => {
    await page.getByRole('button', { name: /Create 3 segments/ }).click();
    await page.getByText(/Narration from “narration-sample.txt”/).waitFor();
    assert((await page.locator('.seg-row').count()) === 3, 'segment rows missing');
    const doc = readDoc();
    assert(doc.narration.voice === 'bf_emma' && doc.narration.segments.length === 3, 'narration not saved');
    assert(doc.narration.segments[1].start === 4 && doc.narration.segments[1].end === 9, 'timestamps lost');
    assert((await statuses()).every((s) => s === 'Not generated'), `statuses: ${await statuses()}`);
  });

  await step('generate all missing: real synthesis writes one WAV per segment', async () => {
    await page.getByRole('button', { name: /Generate 3 missing/ }).click();
    await page.locator('.export-progress').waitFor();
    await waitStatus(/Generated 3 segments/);
    const doc = readDoc();
    for (const seg of doc.narration.segments) {
      assert(seg.status === 'ok' && seg.durationSec > 1, `segment ${seg.id}: ${seg.status} ${seg.durationSec}`);
      assert(fs.existsSync(path.join(PROJECT_DIR, seg.file)), `missing audio file ${seg.file}`);
    }
    assert((await statuses()).every((s) => s === 'Ready'), `statuses: ${await statuses()}`);
  });

  await step('the timeline shows one clip per segment at its start time', async () => {
    const clips = page.locator('[data-track="narration"] .tl-clip');
    assert((await clips.count()) === 3, `clips: ${await clips.count()}`);
    const second = await page.locator('[data-track="narration"] .tl-clip').nth(1).getAttribute('title');
    assert(second.includes('0:04.0'), `second clip title: ${second}`);
  });

  await step('a segment plays back from the project folder', async () => {
    const src = await page.getByLabel('Audio of segment 1').getAttribute('src');
    const dur = await page.evaluate(async (u) => new Promise((resolve, reject) => {
      const a = new Audio(u);
      a.addEventListener('loadedmetadata', () => resolve(a.duration));
      a.addEventListener('error', () => reject(new Error('audio failed to load')));
    }), src);
    assert(dur > 1, `playback duration ${dur}`);
  });

  await step('editing a segment marks it changed; regenerate replaces only that file', async () => {
    const before = readDoc().narration.segments[0];
    await page.getByLabel('Text of segment 1').fill('Every molecule is constantly vibrating, all the time.');
    await page.getByLabel('Text of segment 1').press('Tab');
    await page.waitForFunction(() => /Changed: regenerate/.test(document.querySelector('.seg-row')?.textContent ?? ''));
    await page.getByRole('button', { name: 'Regenerate segment 1' }).click();
    await waitStatus(/Generated 1 segment/);
    const after = readDoc().narration.segments;
    assert(after[0].file !== before.file, 'segment file did not change');
    assert(!fs.existsSync(path.join(PROJECT_DIR, before.file)), 'old audio file was kept');
    assert(after[0].status === 'ok' && after[1].file === readDoc().narration.segments[1].file, 'other segments were touched');
    assert(after[1].status === 'ok', 'segment 2 status changed');
  });

  await step('a speed change marks every segment for regeneration', async () => {
    await setRange('Speed', 1.2);
    await page.waitForFunction(() => /Generate 3 missing/.test(document.body.textContent ?? ''));
    assert(readDoc().narration.speed === 1.2, 'speed not saved');
  });

  await step('cancel stops generation; the segments not yet made stay missing', async () => {
    await page.getByRole('button', { name: /Generate 3 missing/ }).click();
    await page.getByRole('button', { name: 'Cancel' }).waitFor();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await waitStatus(/Stopped after|generated|failed/, 180000);
    const segs = readDoc().narration.segments;
    assert(segs.some((s) => s.status !== 'ok'), 'cancel did not leave any segment missing');
  });

  await step('generating again finishes the missing segments', async () => {
    await page.getByRole('button', { name: /Generate \d missing/ }).click();
    await waitStatus(/Generated \d segments?\./, 300000);
    assert(readDoc().narration.segments.every((s) => s.status === 'ok'), 'some segments still missing');
  });

  await step('a non-Python file is refused as the narration engine', async () => {
    await setPicks({ python: BAD_PYTHON });
    await page.getByRole('button', { name: 'Change…' }).click();
    await page.locator('.status-line.error').waitFor();
    assert((await statusText()).includes('not a working Python'), `message: ${await statusText()}`);
  });

  await step('the narration survives a restart', async () => {
    await page.locator('.topbar').getByRole('button', { name: 'Close project' }).click();
    await stop();
    await launch();
    await page.locator('.recent-item button.open', { hasText: 'Narration stage 3' }).click();
    await page.locator('.app').waitFor();
    await page.locator('.asset-card', { hasText: 'narration-sample.txt' }).click();
    await page.getByText(/Narration from “narration-sample.txt”/).waitFor();
    assert((await page.locator('.seg-row').count()) === 3, 'segments lost on restart');
    assert((await page.getByLabel('Voice', { exact: true }).inputValue()) === 'bf_emma', 'voice lost on restart');
    assert((await statuses()).every((s) => s === 'Ready'), `statuses after restart: ${await statuses()}`);
  });

  console.log('\nAll Stage 3 end-to-end checks passed.');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await stop();
  if (process.env.VV_KEEP !== '1') fs.rmSync(work, { recursive: true, force: true });
  else console.log('kept', work);
}
process.exit(failed ? 1 : 0);
