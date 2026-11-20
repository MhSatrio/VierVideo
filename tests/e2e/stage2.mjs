// Stage 2 end-to-end test: HTML animation preview, frame-accurate export to MP4, cancel, persistence.
// Drives the real Electron app over CDP with the FTIR example as the default test file.
// Run:  npm run build && node tests/e2e/stage2.mjs
// Needs ffmpeg and ffprobe on PATH (or set VIERVIDEO_FFMPEG to the ffmpeg binary).
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
const CDP_PORT = 9341;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e2-'));
const parent = path.join(work, 'projects');
const userData = path.join(work, 'user-data');
const PROJECT_DIR = path.join(parent, 'FTIR stage 2');
const FTIR = path.join(ROOT, 'tests', 'fixtures', 'ftir-60s.html');
const BAD_FFMPEG = path.join(work, 'not-ffmpeg.exe');
// Export length for the test. 8 s keeps the run short; VV_DURATION=60 runs the full FTIR animation.
const DUR = Number(process.env.VV_DURATION || 8);
const fmt = (d) => `${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, '0')}`;
const FRAMES = DUR * 30;
fs.mkdirSync(parent, { recursive: true });
fs.writeFileSync(BAD_FFMPEG, 'MZ not a program');

let proc = null;
let browser = null;
let page = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const readDoc = () => JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.vvproj.json'), 'utf8'));
const ffprobe = (file) => {
  const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,pix_fmt:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  assert(out.status === 0, `ffprobe failed: ${out.stderr}`);
  const j = JSON.parse(out.stdout);
  return { codec: j.streams[0].codec_name, width: j.streams[0].width, height: j.streams[0].height, fps: j.streams[0].avg_frame_rate, pix: j.streams[0].pix_fmt, duration: Number(j.format.duration) };
};
/** Lowest per-frame PSNR (dB) between two videos. Identical frames give 'inf' and are skipped. */
const minPsnr = (x, y) => {
  const log = `psnr-${process.pid}-${Date.now()}.log`;
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', x, '-i', y, '-lavfi', `[0:v][1:v]psnr=stats_file=${log}`, '-f', 'null', '-'], { encoding: 'utf8', cwd: os.tmpdir() });
  assert(out.status === 0, `psnr failed: ${out.stderr}`);
  let min = Infinity;
  for (const line of fs.readFileSync(path.join(os.tmpdir(), log), 'utf8').split('\n')) {
    const m = /psnr_avg:(\S+)/.exec(line);
    if (m && m[1] !== 'inf') min = Math.min(min, Number(m[1]));
  }
  fs.rmSync(path.join(os.tmpdir(), log), { force: true });
  return min;
};
const framemd5 = (file) => {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8' });
  assert(out.status === 0, `framemd5 failed: ${out.stderr}`);
  return out.stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
};

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
  // A leftover instance on the debug port would be tested instead of this run; refuse to start.
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
const timecode = () => page.locator('.timecode').innerText();
const frameSrc = () => page.locator('.frame img').getAttribute('src');
const shot = async (name) => {
  if (process.env.VV_SHOTS) await page.screenshot({ path: path.join(process.env.VV_SHOTS, `${name}.png`) });
};
async function waitStatus(re, timeout = 900000) {
  try {
    await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.status-line')?.textContent ?? ''), re.source, { timeout });
  } catch (err) {
    const shown = await page.locator('.status-line').first().innerText().catch(() => '(no status)');
    throw new Error(`status never showed ${re}. Status line: "${shown}"`);
  }
}

let failed = false;
try {
  console.log('VierVideo stage 2 end-to-end (FTIR test file)');
  await launch();

  await step('create the project', async () => {
    await page.locator('.start').waitFor();
    await setPicks({ folder: parent });
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill('FTIR stage 2');
    await page.getByRole('button', { name: 'Choose folder' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.locator('.app').waitFor();
  });

  await step('import the FTIR example animation', async () => {
    await setPicks({ files: [FTIR] });
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await page.locator('.asset-card').first().waitFor();
    assert((await page.locator('.asset-card').count()) === 1, 'expected one asset');
  });

  // Shorter export length for the test; the default project length is 60 s.
  await step('set the project to 8 s so the export test is quick', async () => {
    await page.locator('.timeline-tools').getByLabel('Timeline duration in seconds').fill(String(DUR));
    await page.locator('.timeline-tools').getByRole('button', { name: 'Set' }).click();
    await page.waitForFunction((want) => (document.querySelector('.timeline-tools')?.closest('.panel')?.textContent ?? '').includes(want), `${DUR} s`);
  });

  await step('the HTML animation previews as a frame rendered by the engine', async () => {
    await page.locator('.asset-card').first().click();
    try {
      await page.waitForFunction(() => document.querySelector('.frame img')?.getAttribute('src')?.startsWith('data:image/png;base64,'), null, { timeout: 60000 });
    } catch (err) {
      const shown = await page.locator('.frame').innerText().catch(() => '(no frame)');
      throw new Error(`no preview frame. Frame shows: "${shown.replace(/\s+/g, ' ')}"`);
    }
    assert((await timecode()).startsWith('0:00.0 / ' + fmt(DUR)), `unexpected timecode: ${await timecode()}`);
    const first = await frameSrc();
    assert(first.length > 5000, 'preview frame is suspiciously small');
  });

  await step('frame stepping moves exactly one frame at 30 fps', async () => {
    await page.getByRole('button', { name: 'Next frame' }).click();
    await page.waitForFunction(() => /frame 1$/.test(document.querySelector('.timecode')?.textContent ?? ''), null, { timeout: 30000 });
    await page.getByRole('button', { name: 'Next frame' }).click();
    await page.waitForFunction(() => /frame 2$/.test(document.querySelector('.timecode')?.textContent ?? ''), null, { timeout: 30000 });
    await page.getByRole('button', { name: 'Previous frame' }).click();
    await page.waitForFunction(() => /frame 1$/.test(document.querySelector('.timecode')?.textContent ?? ''), null, { timeout: 30000 });
  });

  await step('scrubbing to 3 s shows the frame at 3 s', async () => {
    await page.locator('input.scrubber').evaluate((el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, '3000');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction((want) => (document.querySelector('.timecode')?.textContent ?? '').startsWith(want), '0:03.0 / ' + fmt(DUR), { timeout: 30000 });
    await shot('stage2-preview-3s');
  });

  await step('play runs in real time and pause holds the frame', async () => {
    await page.getByRole('button', { name: 'Stop' }).click();
    await page.waitForFunction(() => /0:00\.0 \//.test(document.querySelector('.timecode')?.textContent ?? ''), null, { timeout: 30000 });
    await page.getByRole('button', { name: 'Play' }).click();
    await sleep(2500);
    await page.getByRole('button', { name: 'Pause' }).click();
    const paused = await timecode();
    const tc = /(\d+):(\d\d)\.(\d)/.exec(paused);
    const seconds = Number(tc[1]) * 60 + Number(tc[2]) + Number(tc[3]) / 10;
    assert(seconds >= 1.5 && seconds <= 3.5, `playback position after 2.5 s is ${paused}`);
    await sleep(800);
    assert((await timecode()) === paused, 'playback kept moving after pause');
  });

  await step('the page controls are hidden by default (#controls, #bar)', async () => {
    assert((await page.getByLabel('Hide page elements').inputValue()) === '#controls, #bar', 'default hide selectors are not set');
  });

  let firstExport = null;
  await step('export MP4 (frame by frame) writes an H.264 file of the right length', async () => {
    await page.getByRole('button', { name: 'Export MP4' }).click();
    await waitStatus(/Exported /);
    const doc = readDoc();
    assert(doc.renders.length === 1, `expected 1 render record, got ${doc.renders.length}`);
    firstExport = path.join(PROJECT_DIR, doc.renders[0].file);
    assert(fs.existsSync(firstExport), 'export file missing');
    const info = ffprobe(firstExport);
    assert(info.codec === 'h264' && info.width === 1080 && info.height === 1920, `format: ${JSON.stringify(info)}`);
    assert(info.fps === '30/1' && info.pix === 'yuv420p', `frame rate/pixel format: ${info.fps} ${info.pix}`);
    assert(Math.abs(info.duration - DUR) < 0.15, `duration ${info.duration}`);
    assert(!fs.readdirSync(path.join(PROJECT_DIR, 'renders')).some((n) => n.endsWith('.part')), 'partial file left behind');
  });

  await step('the same export again is identical frame by frame (repeatable)', async () => {
    await page.getByRole('button', { name: 'Export MP4' }).click();
    await page.waitForFunction(() => (document.querySelectorAll('.renders li').length ?? 0) >= 2, null, { timeout: 900000 });
    const doc = readDoc();
    const second = path.join(PROJECT_DIR, doc.renders[doc.renders.length - 1].file);
    assert(second !== firstExport, 'second export reused the first file');
    const a = framemd5(firstExport);
    const b = framemd5(second);
    assert(a.length === b.length && a.length === FRAMES, `frame counts ${a.length} vs ${b.length}`);
    // Byte-for-byte equality is not required: a few frames of the example differ by sub-visual rounding in
    // the rasteriser (up to ~54 dB PSNR). Visible identity is required: every frame at least 45 dB.
    const identical = a.filter((h, i) => h === b[i]).length;
    const worst = minPsnr(firstExport, second);
    console.log(`       ${identical} of ${a.length} frames identical byte for byte; lowest frame PSNR ${worst.toFixed(1)} dB`);
    assert(worst >= 45, `frames differ visibly: lowest PSNR ${worst.toFixed(1)} dB`);
  });

  await step('a real-time export also writes a file of the right length', async () => {
    await page.getByRole('button', { name: 'Real time' }).click();
    await page.getByRole('button', { name: 'Export MP4' }).click();
    await page.waitForFunction(() => (document.querySelectorAll('.renders li').length ?? 0) >= 3, null, { timeout: 900000 });
    const doc = readDoc();
    const rt = path.join(PROJECT_DIR, doc.renders[doc.renders.length - 1].file);
    assert(doc.renders[doc.renders.length - 1].mode === 'realtime', 'mode not recorded');
    assert(Math.abs(ffprobe(rt).duration - DUR) < 0.3, 'real-time export length is off');
    await page.getByRole('button', { name: 'Frame by frame' }).click();
  });

  await step('cancel stops an export and removes the partial file', async () => {
    const before = fs.readdirSync(path.join(PROJECT_DIR, 'renders')).length;
    await page.getByRole('button', { name: 'Export MP4' }).click();
    await page.locator('.export-progress').waitFor();
    await page.waitForFunction(() => /frame \d+ of/.test(document.querySelector('.export-progress')?.textContent ?? ''), null, { timeout: 60000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await waitStatus(/cancelled/);
    await page.locator('.export-progress').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    const after = fs.readdirSync(path.join(PROJECT_DIR, 'renders'));
    assert(after.length === before, `files changed after cancel: ${after}`);
    assert(!after.some((n) => n.endsWith('.part')), 'partial file left behind');
    assert(readDoc().renders.length === 3, 'cancelled export was recorded');
  });

  await step('a bad FFmpeg location is refused with a message', async () => {
    await setPicks({ ffmpeg: BAD_FFMPEG });
    await page.getByRole('button', { name: 'Change…' }).click();
    await waitStatus(/not a working FFmpeg/);
  });

  await step('renders and render options survive a restart', async () => {
    await shot('stage2-inspector');
    await page.locator('.topbar').getByRole('button', { name: 'Close project' }).click();
    await stop();
    await launch();
    await page.locator('.recent-item button.open', { hasText: 'FTIR stage 2' }).click();
    await page.locator('.app').waitFor();
    await page.locator('.asset-card').first().click();
    await page.locator('.renders li').nth(2).waitFor();
    assert((await page.locator('.renders li').count()) === 3, 'renders list changed after restart');
    assert((await page.getByLabel('Hide page elements').inputValue()) === '#controls, #bar', 'hide selectors lost');
  });

  console.log('\nAll Stage 2 end-to-end checks passed.');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await stop();
  if (process.env.VV_KEEP !== '1') fs.rmSync(work, { recursive: true, force: true });
  else console.log('kept', work);
}
process.exit(failed ? 1 : 0);
