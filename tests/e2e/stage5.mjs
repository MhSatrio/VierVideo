// Stage 5 end-to-end test: the final render. Narration (real Kokoro speech) and a music file are mixed into the
// timeline video. Checks the file, and checks the sound against the real timing of each narration segment: silence
// in the gap, speech starting exactly at each segment's start time, and the music under the gap.
// Drives the real Electron app over CDP.
// Run:  npm run build && node tests/e2e/stage5.mjs   (needs ffmpeg/ffprobe on PATH and the vier-tts venv)
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
const CDP_PORT = 9347;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e5-'));
const parent = path.join(work, 'projects');
const userData = path.join(work, 'user-data');
const PROJECT_DIR = path.join(parent, 'Final stage 5');
const SCRIPT = path.join(ROOT, 'tests', 'fixtures', 'narration-sample.txt');
const FTIR = path.join(ROOT, 'tests', 'fixtures', 'ftir-60s.html');
const TONE = path.join(work, 'tone100.wav');
const DUR = 15;
fs.mkdirSync(parent, { recursive: true });

let proc = null;
let browser = null;
let page = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const readDoc = () => JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.vvproj.json'), 'utf8'));
const clipsOn = (track) => readDoc().timeline.tracks.find((t) => t.id === track).clips;

/** Polls a condition on the saved project file until it holds (the page saves every change). */
async function waitDoc(pred, what, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred(readDoc())) return;
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
async function waitStatus(re, timeout = 900000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.status-line')?.textContent ?? ''), re.source, { timeout });
}

/** Seconds of a media file, from ffprobe. */
function probeSec(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const v = Number(r.stdout.trim());
  assert(Number.isFinite(v) && v > 0, `ffprobe could not read ${file}: ${r.stderr}`);
  return v;
}

/**
 * Mean volume (dB) of a time window of the exported file, after an optional filter.
 * The seek (-ss, -t) must come BEFORE -i: with the seek after the input, this FFmpeg build reads the same
 * level for every window (checked: silent spans read -34 dB instead of -91 dB).
 */
function meanDb(file, from, len, af = '') {
  const filter = af ? `${af},volumedetect` : 'volumedetect';
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(from), '-t', String(len), '-i', file, '-af', filter, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  assert(m, `no volume reading at ${from}s: ${r.stderr.slice(-300)}`);
  return Number(m[1]);
}

// Filters. The test tone is 100 Hz; speech is mostly above 400 Hz. Two 400 Hz high-passes take the tone down by
// about 48 dB, so a speech check is not fooled by the music. The low-pass keeps only the tone.
const SPEECH = 'highpass=f=400,highpass=f=400';
const TONE_ONLY = 'lowpass=f=150';

const measured = {};
let failed = false;
try {
  console.log('VierVideo stage 5 end-to-end (final render with narration and music)');
  // A 100 Hz tone at the default level: easy to tell from speech by filtering. Made once for the test.
  assert(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=100:duration=${DUR}`, '-ac', '2', TONE]).status === 0, 'could not make the test tone');
  await launch();

  await step('create the project (15 s), import the narration script, the tone and the FTIR animation', async () => {
    await page.locator('.start').waitFor();
    await setPicks({ folder: parent });
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill('Final stage 5');
    await page.getByRole('button', { name: 'Choose folder' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.locator('.app').waitFor();
    await page.locator('.timeline-tools').getByLabel('Timeline duration in seconds').fill(String(DUR));
    await page.locator('.timeline-tools').getByRole('button', { name: 'Set' }).click();
    await page.waitForFunction((d) => (document.querySelector('.timeline-tools')?.closest('.panel')?.textContent ?? '').includes(`${d} s`), DUR);
    await setPicks({ files: [SCRIPT, TONE, FTIR] });
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await page.locator('.asset-card', { hasText: 'narration-sample.txt' }).waitFor();
    await page.locator('.asset-card', { hasText: 'tone100.wav' }).waitFor();
    await page.locator('.asset-card', { hasText: 'ftir-60s.html' }).waitFor();
  });

  await step('the FTIR animation goes on the HTML track, as long as the project', async () => {
    await page.locator('.asset-card', { hasText: 'ftir-60s.html' }).click();
    await page.getByTestId('add-html').click();
    await page.locator('[data-track="html"] .tl-clip').waitFor();
    await waitDoc((d) => d.timeline.tracks.find((t) => t.id === 'html').clips.length === 1, 'the html clip');
    const html = clipsOn('html');
    assert(html[0].start === 0 && html[0].duration === DUR, `html clip: ${JSON.stringify(html)}`);
  });

  await step('narration: create the three timed segments and generate them (real speech)', async () => {
    await page.locator('.asset-card', { hasText: 'narration-sample.txt' }).click();
    await page.getByRole('button', { name: /Create 3 segments/ }).click();
    await page.getByRole('button', { name: /Generate 3 missing/ }).click();
    await waitStatus(/Generated 3 segments/, 900000);
    assert(readDoc().narration.segments.every((s) => s.status === 'ok'), 'some segments were not generated');
  });

  await step('music: add the tone as a music clip, and set it to the project length', async () => {
    await page.locator('.asset-card', { hasText: 'tone100.wav' }).click();
    await page.getByTestId('add-music').click();
    // The new clip is selected, so the inspector shows its duration. A new music clip is 10 s long by default.
    await page.getByLabel('Duration (s)').fill(String(DUR));
    await page.getByLabel('Duration (s)').press('Enter');
    await waitDoc((d) => {
      const m = d.timeline.tracks.find((t) => t.id === 'music').clips;
      return m.length === 1 && m[0].duration === DUR && m[0].start === 0;
    }, 'the music clip to be 15 s long from 0 s');
  });

  await step('export the timeline with its sound', async () => {
    await page.getByTestId('export-timeline').click();
    await waitStatus(/Exported timeline-.*sound from 4 clips/, 900000);
    const rec = readDoc().renders.find((r) => r.kind === 'timeline');
    assert(rec && rec.audioClips === 4, `render record: ${JSON.stringify(rec)}`);
    const dir = fs.readdirSync(path.join(PROJECT_DIR, 'renders'));
    assert(!dir.some((n) => n.startsWith('.video-')), `temporary video left behind: ${dir.join(', ')}`);
  });

  const rec = readDoc().renders.find((r) => r.kind === 'timeline');
  const out = path.join(PROJECT_DIR, rec.file);
  const segFile = (i) => path.join(PROJECT_DIR, readDoc().narration.segments[i].file);

  await step('the file has one H.264 video and one AAC audio track of the project length', async () => {
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', out], { encoding: 'utf8' });
    const j = JSON.parse(probe.stdout);
    const v = j.streams.find((s) => s.codec_type === 'video');
    const a = j.streams.find((s) => s.codec_type === 'audio');
    assert(v && v.codec_name === 'h264' && v.width === 1080 && v.height === 1920, `video: ${JSON.stringify(v)}`);
    assert(a && a.codec_name === 'aac', `audio: ${JSON.stringify(a)}`);
    assert(Math.abs(Number(j.format.duration) - DUR) < 0.2, `duration ${j.format.duration}`);
  });

  // The segments' own speech lengths decide where the silent gap is. Segment 1 starts at 0 s, segment 2 at 4 s.
  const d1 = probeSec(segFile(0));
  measured.segment1SpeechSec = d1;

  await step('the gap between segments 1 and 2 is silent (no speech at 3.8–3.96 s)', async () => {
    assert(d1 < 3.7, `segment 1 speech lasts ${d1.toFixed(2)} s, which overlaps the silent check window`);
    const db = meanDb(out, 3.8, 0.16, SPEECH);
    measured.gapSpeechDb = db;
    assert(db < -50, `speech band level ${db.toFixed(1)} dB just before segment 2 starts`);
  });

  await step('speech starts with segment 2 at 4.0 s (sync: 4.04–4.2 s is speech)', async () => {
    const db = meanDb(out, 4.04, 0.16, SPEECH);
    measured.seg2OnsetDb = db;
    assert(db > -40, `speech band level ${db.toFixed(1)} dB just after 4.0 s`);
  });

  await step('speech starts with segment 3 at 9.0 s (sync: 9.04–9.2 s is speech)', async () => {
    const db = meanDb(out, 9.04, 0.16, SPEECH);
    measured.seg3OnsetDb = db;
    assert(db > -40, `speech band level ${db.toFixed(1)} dB just after 9.0 s`);
  });

  await step('the music plays in the silent gap (the 100 Hz tone is there, the speech is not)', async () => {
    const from = d1 + 0.2;
    const len = 3.7 - from;
    assert(len >= 0.3, `gap too short for the music check: ${len.toFixed(2)} s`);
    const db = meanDb(out, from, len, TONE_ONLY);
    measured.toneDbInGap = db;
    // A full-level sine is about -21 dB RMS. Anything above -32 means the music is in the mix.
    assert(db > -32, `tone level ${db.toFixed(1)} dB in the gap`);
  });

  await step('the music continues to the end of the project (13.5–14.8 s, tone only)', async () => {
    const db = meanDb(out, 13.5, 1.3, TONE_ONLY);
    measured.toneDbAtEnd = db;
    assert(db > -32, `tone level ${db.toFixed(1)} dB near the end`);
  });

  await step('the project, the narration, the animation and the music survive a restart', async () => {
    await page.locator('.topbar').getByRole('button', { name: 'Close project' }).click();
    await stop();
    await launch();
    await page.locator('.recent-item button.open', { hasText: 'Final stage 5' }).click();
    await page.locator('.app').waitFor();
    await page.locator('[data-track="narration"] .tl-clip').first().waitFor();
    assert((await page.locator('[data-track="narration"] .tl-clip').count()) === 3, 'narration clips lost');
    assert((await page.locator('[data-track="music"] .tl-clip').count()) === 1, 'music clip lost');
    assert((await page.locator('[data-track="html"] .tl-clip').count()) === 1, 'animation clip lost');
  });

  console.log(`\nMeasured: ${JSON.stringify(Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v])))}`);
  console.log('All Stage 5 end-to-end checks passed.');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await stop();
  if (process.env.VV_KEEP === '1') {
    console.log('kept', work);
  } else {
    // Electron can hold files for a moment after it exits; retry, and do not fail the test over cleanup.
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (err) {
      console.warn(`could not remove ${work}: ${err.message}`);
    }
  }
}
process.exit(failed ? 1 : 0);
