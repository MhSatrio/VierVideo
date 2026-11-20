// VierVideo desktop shell. The main process owns the open project; the renderer asks for changes over IPC
// and gets back the new project state. Assets are served to the renderer through the vvasset:// scheme.
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, protocol, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProject, openProject, ProjectError } from './lib/project.mjs';
import { RecentProjects } from './lib/recent.mjs';
import { Settings } from './lib/settings.mjs';
import { probeFfmpeg, findFfmpeg } from './lib/render/ffmpeg.mjs';
import { renderVideo, RenderCancelled } from './lib/render/job.mjs';
import { openRenderSession } from './lib/render/session.mjs';
import { NarrationWorker, findPython, probePython, pythonCandidates } from './lib/tts/worker.mjs';
import { layerStates } from '../shared/timeline.mjs';
import { planAudioMix } from '../shared/audiomix.mjs';
import { muxArgs, mixArgs, runFfmpeg } from './lib/render/mux.mjs';
import { existsSync } from 'node:fs';
import { hashString, isValidVoice, clampSpeed, segmentSignature, SYNTH_VERSION } from '../shared/narration.mjs';
import { safeName } from './lib/fsx.mjs';
import { narrationFiles, examplePaths } from './lib/paths.mjs';
import { createExample } from './lib/example.mjs';
import {
  FPS_OPTIONS, MAX_DURATION_SEC, MIN_DURATION_SEC, SUPPORTED_EXTENSIONS, activeOpOffsets, frameSize, normalizeRenderOptions, sameScene,
} from '../shared/project-format.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist');
const FONT_FILE = path.join(here, 'assets', 'jost-latin-wght-normal.woff2');
const FONT_CSS = "@font-face{font-family:'Jost';font-style:normal;font-weight:100 900;font-display:block;src:url(vvfont://file/jost.woff2) format('woff2');}";
const E2E = process.env.VV_E2E === '1';
const DEV_URL = process.env.VV_DEV_URL || '';

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'vvapp', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'vvasset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'vvfont', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'vvproj', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Tests use their own user-data folder so they never touch the real recent-projects list.
if (process.env.VV_USER_DATA) app.setPath('userData', process.env.VV_USER_DATA);
// The preview's sound starts after the timeline's mix is made, which can take longer than a click's user gesture lasts.
// The sound is the program's own output, so it may start without one.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

let win = null;
let current = null; // open Project
let recent = null;
let settings = null;
let preview = null; // { key, session }
let previewChain = Promise.resolve();
let exportJob = null; // { id, controller }
let nextJobId = 1;
// Test-only: when VV_E2E=1 the native dialogs are replaced by these values.
const picks = { folder: null, files: null, ffmpeg: null, python: null };
// The example project opens by itself the first time the program starts. In tests only when asked for.
const AUTO_EXAMPLE = E2E ? process.env.VV_AUTO_EXAMPLE === '1' : true;

// Narration engine (Kokoro through tools/tts/worker.py). One process, started on first use.
const TTS = narrationFiles({ here, packaged: app.isPackaged, resourcesPath: process.resourcesPath });
const PREVIEW_TEXT = 'Every molecule is constantly vibrating.';
let engine = null;
let narrationJob = null; // { controller }

const ok = (data) => ({ ok: true, data });
const fail = (err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) });

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return ok(await fn(payload ?? {}));
    } catch (err) {
      if (!(err instanceof ProjectError)) console.error(`[${channel}]`, err);
      return fail(err);
    }
  });
}

function requireProject() {
  if (!current) throw new ProjectError('Open or create a project first.');
  return current;
}

async function stateOf() {
  return current ? current.state() : null;
}

function htmlAssetOf(state, assetId) {
  const asset = state.doc.assets.find((a) => a.id === assetId);
  if (!asset) throw new ProjectError('That asset is no longer in the project.');
  if (asset.kind !== 'html') throw new ProjectError('Only HTML animations can be rendered.');
  if (state.missing.includes(asset.id)) throw new ProjectError(`The file for "${asset.name}" is missing from the project folder.`);
  return asset;
}

// ---------- protocols ----------

async function serveApp(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '' || rel === '/') rel = '/index.html';
  const file = path.resolve(DIST, '.' + rel);
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).href);
}

async function serveAsset(request) {
  const url = new URL(request.url);
  const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const file = current ? current.assetFile(id) : null;
  if (!file) return new Response('Not found', { status: 404 });
  return net.fetch(pathToFileURL(file).href);
}

// Fonts for the render windows. Cross-origin font loads need the CORS header.
async function serveFont(request) {
  const url = new URL(request.url);
  const headers = { 'Access-Control-Allow-Origin': '*' };
  if (url.host === 'css') return new Response(FONT_CSS, { headers: { ...headers, 'Content-Type': 'text/css' } });
  if (url.host === 'file' && url.pathname === '/jost.woff2') {
    const bytes = await fs.readFile(FONT_FILE);
    return new Response(bytes, { headers: { ...headers, 'Content-Type': 'font/woff2' } });
  }
  return new Response('Not found', { status: 404 });
}

const MEDIA_TYPES = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

async function serveProjectFile(request) {
  try {
    const res = await serveProjectFileNow(request);
    if (process.env.VV_DEBUG === '1') console.error('[vvproj]', request.url, res.status);
    return res;
  } catch (err) {
    console.error('[vvproj]', request.url, 'failed:', err && err.message);
    return new Response('The file could not be read.', { status: 500 });
  }
}

async function serveProjectFileNow(request) {
  const url = new URL(request.url);
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = current ? current.fileInside(rel) : null;
  if (!file || !existsSync(file)) {
    if (process.env.VV_DEBUG === '1') console.error('[vvproj] missing', JSON.stringify(rel), file, Boolean(current));
    return new Response('Not found', { status: 404 });
  }
  // A media element asks for byte ranges (to start and to seek). Those are answered in part, as the player requires;
  // anything else is the whole file.
  const range = request.headers.get('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    const size = (await fs.stat(file)).size;
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response('Range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const handle = await fs.open(file, 'r');
    let body;
    try {
      body = Buffer.alloc(end - start + 1);
      await handle.read(body, 0, body.length, start);
    } finally {
      await handle.close();
    }
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Type': MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(body.length),
        'Accept-Ranges': 'bytes',
      },
    });
  }
  return net.fetch(pathToFileURL(file).href);
}

function registerProtocols() {
  protocol.handle('vvproj', serveProjectFile);
  protocol.handle('vvapp', serveApp);
  protocol.handle('vvasset', serveAsset);
  protocol.handle('vvfont', serveFont);
}

// ---------- rendering ----------

const renderHandlers = { asset: serveAsset, font: serveFont };

function assetAddress(asset) {
  return `vvasset://asset/${encodeURIComponent(asset.id)}`;
}

async function resolveFfmpeg() {
  const saved = await settings.read();
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return findFfmpeg([
    { source: 'settings', path: saved.ffmpegPath ?? null },
    { source: 'environment', path: process.env.VIERVIDEO_FFMPEG || null },
    { source: 'bundled', path: app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg', exe) : null },
    { source: 'PATH', path: 'ffmpeg' },
  ]);
}

function enqueuePreview(fn) {
  const next = previewChain.then(fn);
  previewChain = next.catch(() => {});
  return next;
}

async function closePreview() {
  const s = preview?.session;
  preview = null;
  if (s) await s.close();
  const c = compPreview;
  compPreview = null;
  if (c) await c.comp.close();
}

async function previewFrame({ assetId, timeMs }) {
  const proj = requireProject();
  const state = await proj.state();
  const asset = htmlAssetOf(state, assetId);
  const opts = normalizeRenderOptions(asset.render);
  const { width, height } = frameSize(state.doc.settings);
  const key = [proj.dir, asset.id, asset.sha256, opts.mode, opts.hideSelectors, width, height].join('|');
  if (!preview || preview.key !== key) {
    await closePreview();
    const session = await openRenderSession({
      url: assetAddress(asset), width, height, mode: opts.mode, hideSelectors: opts.hideSelectors, handlers: renderHandlers,
    });
    preview = { key, session };
  }
  const png = await preview.session.frame(Math.max(0, Number(timeMs) || 0));
  return { png: png.toString('base64'), warnings: preview.session.warnings };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function exportVideo({ assetId, fps, durationSec, mode }) {
  if (exportJob) throw new ProjectError('A video is already being exported. Wait for it to finish or cancel it.');
  const proj = requireProject();
  const state = await proj.state();
  const asset = htmlAssetOf(state, assetId);
  const settingsNow = state.doc.settings;
  const f = Number(fps ?? settingsNow.fps);
  const d = Number(durationSec ?? settingsNow.durationSec);
  if (!FPS_OPTIONS.includes(f)) throw new ProjectError('Frame rate must be 30 or 60 fps.');
  if (!(d >= MIN_DURATION_SEC && d <= MAX_DURATION_SEC)) {
    throw new ProjectError(`Duration must be between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC} seconds.`);
  }
  const opts = normalizeRenderOptions(asset.render);
  const useMode = normalizeRenderOptions({ ...opts, mode: mode ?? opts.mode }).mode;
  const ff = await resolveFfmpeg();
  if (!ff) throw new ProjectError('FFmpeg was not found. Install FFmpeg, or choose its location in the Render section of the Inspector.');
  const { width, height } = frameSize(settingsNow);
  const baseName = safeName(path.parse(asset.name).name, 'render');
  const fileName = `${baseName}-${f}fps-${stamp()}.mp4`;
  const outFile = await proj.renderTarget(fileName);

  const id = nextJobId++;
  const controller = new AbortController();
  exportJob = { id, controller };
  try {
    const result = await renderVideo({
      openSession: ({ mode: m }) => openRenderSession({
        url: assetAddress(asset), width, height, mode: m, hideSelectors: opts.hideSelectors, handlers: renderHandlers,
      }),
      outFile,
      ffmpegPath: ff.path,
      fps: f,
      durationSec: d,
      mode: useMode,
      signal: controller.signal,
      onProgress: (p) => win?.webContents.send('render:progress', { id, ...p }),
    });
    const record = {
      id: 'r_' + randomBytes(5).toString('hex'),
      assetId: asset.id,
      file: `renders/${fileName}`,
      fps: f,
      durationSec: d,
      mode: useMode,
      frames: result.frames,
      bytes: result.bytes,
      createdAt: new Date().toISOString(),
    };
    await proj.addRender(record);
    return { id, render: record, warnings: result.warnings, state: await proj.state() };
  } catch (err) {
    if (err instanceof RenderCancelled) throw new ProjectError('The export was cancelled. The partial file was removed.');
    throw err;
  } finally {
    exportJob = null;
  }
}

// ---------- narration ----------

async function resolvePython() {
  const saved = await settings.read();
  return findPython(pythonCandidates({ settingsPython: saved.pythonPath ?? null }));
}

/** Uses the model cache under LOCALAPPDATA/vier-tts when HF_HOME is not set. Nothing is downloaded (HF_HUB_OFFLINE). */
function hfEnv() {
  if (process.env.HF_HOME || !process.env.LOCALAPPDATA) return {};
  const cache = path.join(process.env.LOCALAPPDATA, 'vier-tts', 'hf-cache');
  return existsSync(cache) ? { HF_HOME: cache } : {};
}

async function ensureEngine() {
  const py = await resolvePython();
  if (!py) {
    throw new ProjectError('The narration engine was not found. Install it with setup-narration.ps1 (in the tts folder of the program), set VIERVIDEO_PYTHON, or choose Python in the Narration section.');
  }
  if (!engine || engine.python !== py.path) {
    engine?.stop('The narration engine was switched.');
    engine = new NarrationWorker({ python: py.path, script: TTS.script, env: hfEnv() });
  }
  return engine;
}

async function voiceCatalog() {
  const cfg = JSON.parse(await fs.readFile(TTS.config, 'utf8'));
  return { voices: cfg.voices, defaultVoice: cfg.default_voice, speedMin: cfg.speed_min, speedMax: cfg.speed_max };
}

async function ttsStatus() {
  const py = await resolvePython();
  if (!py) return { python: null, ready: false };
  try {
    const e = await ensureEngine();
    await e.request('ping', {}, 60000);
    return { python: py, ready: true };
  } catch (err) {
    return { python: py, ready: false, error: err.message };
  }
}

async function previewVoice({ voice, speed }) {
  if (!isValidVoice(voice)) throw new ProjectError('That voice is not in the voice pack.');
  const sp = clampSpeed(speed);
  const proj = requireProject();
  const key = hashString(SYNTH_VERSION + '|' + PREVIEW_TEXT + '|' + voice + '|' + sp.toFixed(2));
  const rel = `audio/previews/${voice}-${key}.wav`;
  const out = await proj.audioTarget(rel);
  if (!existsSync(out)) {
    const e = await ensureEngine();
    await e.request('synth', { text: PREVIEW_TEXT, voice, speed: sp, out }, 600000);
  }
  return { file: rel };
}

/** Synthesises the chosen segments (by default all that are not ready). Progress goes to the window. */
async function generateNarration({ segmentIds }, signal, onProgress) {
  const proj = requireProject();
  const state = await proj.state();
  const n = state.doc.narration;
  if (!n) throw new ProjectError('Create a narration from a script first.');
  const targets = n.segments.filter((seg) => (segmentIds ? segmentIds.includes(seg.id) : seg.status !== 'ok'));
  if (targets.length === 0) return { done: 0, failed: 0, cancelled: false, state };
  const e = await ensureEngine();
  let done = 0;
  let failed = 0;
  onProgress({ total: targets.length, done: 0 });
  for (const seg of targets) {
    if (signal.aborted) break;
    const sig = segmentSignature({ text: seg.text, voice: n.voice, speed: n.speed });
    const rel = `audio/narration/${seg.id}-${sig}.wav`;
    const out = await proj.audioTarget(rel);
    try {
      const r = await e.request('synth', { text: seg.text, voice: n.voice, speed: n.speed, out }, 600000);
      if (signal.aborted) {
        await fs.rm(out, { force: true });
        break;
      }
      await proj.setSegmentAudio(seg.id, { file: rel, durationSec: r.durationSec, signature: sig });
      if (seg.file && seg.file !== rel) {
        const old = proj.fileInside(seg.file);
        if (old) await fs.rm(old, { force: true }).catch(() => {});
      }
      done++;
    } catch (err) {
      await fs.rm(out, { force: true }).catch(() => {});
      if (signal.aborted) break;
      await proj.setSegmentError(seg.id, err.message);
      failed++;
    }
    onProgress({ total: targets.length, done: done + failed, segmentId: seg.id });
  }
  return { done, failed, cancelled: signal.aborted, state: await proj.state() };
}

// ---------- composition (timeline, Stage 4) ----------

const COMP_CSS = "@font-face{font-family:'Jost';font-style:normal;font-weight:100 900;font-display:block;src:url(vvfont://file/jost.woff2) format('woff2');}";
let compPreview = null; // { key, comp }

/** The one HTML animation of the timeline (the base of the picture), or null. */
function htmlClipOf(doc) {
  for (const tr of doc.timeline.tracks) {
    for (const c of tr.clips) if (c.kind === 'html') return c;
  }
  return null;
}

/** Render page for the timeline: the HTML animation as the base, or a blank page when there is none. */
async function openComposition(doc, mode) {
  const { width, height } = frameSize(doc.settings);
  const clip = htmlClipOf(doc);
  const base = clip ? doc.assets.find((a) => a.id === clip.assetId) : null;
  if (clip && !base) throw new ProjectError('The HTML animation is no longer in the project.');
  const opts = base ? normalizeRenderOptions(base.render) : { mode: 'deterministic', hideSelectors: '' };
  const session = await openRenderSession({
    url: base ? assetAddress(base) : null,
    width,
    height,
    mode: base ? (mode ?? opts.mode) : 'deterministic',
    hideSelectors: opts.hideSelectors,
    composition: { w: width, h: height, css: COMP_CSS, assetBase: 'vvasset://asset/' },
    handlers: renderHandlers,
  });
  return session;
}

/** What one frame of the timeline shows: the animation time (ms) and the layer state. */
function compositionFrame(doc, timeSec) {
  const ls = layerStates(doc.timeline.tracks, timeSec);
  const clip = htmlClipOf(doc);
  const base = clip ? doc.assets.find((a) => a.id === clip.assetId) : null;
  return {
    animMs: ls.base.animSec * 1000,
    state: {
      base: { visible: ls.base.visible },
      layers: ls.layers,
      offsets: base?.render?.elementOffsets ?? [],
      // Only the part moves that apply at this time: a paint call with the same number elsewhere is another part.
      opOffsets: activeOpOffsets(base?.render?.opOffsets, timeSec).map((o) => ({ index: o.index, sx: o.sx, sy: o.sy, dx: o.dx, dy: o.dy })),
    },
  };
}

/** The preview's render page. It is reopened when the animation changes (its file, its checksum or its options). */
async function ensureCompPreview(proj, doc) {
  const clip = htmlClipOf(doc);
  const base = clip ? doc.assets.find((a) => a.id === clip.assetId) : null;
  // Element offsets are not part of the page (they are sent with each frame), so moving an element does not reopen it.
  const pageRender = base?.render ? { ...base.render, elementOffsets: undefined, opOffsets: undefined, partGroups: undefined } : null;
  const key = [proj.dir, base?.id ?? '-', base?.sha256 ?? '-', JSON.stringify(pageRender), doc.settings.aspect].join('|');
  if (!compPreview || compPreview.key !== key) {
    const old = compPreview;
    compPreview = null;
    if (old) await old.comp.close();
    compPreview = { key, comp: await openComposition(doc) };
  }
  return compPreview.comp;
}

async function previewComposition({ timeMs }) {
  const proj = requireProject();
  const st = await proj.state();
  const comp = await ensureCompPreview(proj, st.doc);
  const { animMs, state } = compositionFrame(st.doc, Math.max(0, Number(timeMs) || 0) / 1000);
  const png = await comp.frame(animMs, state);
  return { png: png.toString('base64'), warnings: comp.warnings };
}

/** The element of the animation under a point of the frame (in frame pixels), at a time. For the studio. */
async function inspectComposition({ timeMs, x, y }) {
  const proj = requireProject();
  const st = await proj.state();
  const comp = await ensureCompPreview(proj, st.doc);
  const { animMs, state } = compositionFrame(st.doc, Math.max(0, Number(timeMs) || 0) / 1000);
  await comp.frame(animMs, state); // draw the time first, so the page is in the state that the preview shows
  return comp.inspect(Number(x), Number(y));
}

/** Where the example goes. Not OneDrive: its sync client locks files while they are written. Tests use their own folder. */
function exampleParent() {
  return E2E ? path.join(app.getPath('userData'), 'examples') : path.join(os.homedir(), 'VierVideo');
}

/** Opens the example project, creating it the first time (or again when its folder has been deleted). */
async function openExample() {
  const saved = await settings.read();
  let proj;
  let created = false;
  if (saved.exampleDir && (await fs.stat(path.join(saved.exampleDir, 'project.vvproj.json')).then(() => true, () => false))) {
    proj = await openProject(saved.exampleDir);
  } else {
    proj = await createExample({
      parentDir: exampleParent(),
      files: examplePaths({ here, packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    });
    created = true;
    await settings.update({ exampleDir: proj.dir });
  }
  await closePreview();
  current = proj;
  await recent.add({ dir: proj.dir, name: proj.name });
  return { state: await stateOf(), created };
}

// ---------- preview with sound ----------

let previewAudioQueue = Promise.resolve();

/**
 * The timeline's sound as one WAV file, for playing the preview with sound. It is the export's mix (same filter), so
 * what is heard in the preview is what the video will have. Made once for each state of the audio; the older files of
 * the preview are removed. Requests are queued, so two cannot write the same file.
 */
function previewAudio() {
  const run = previewAudioQueue.then(() => previewAudioNow());
  previewAudioQueue = run.catch(() => {});
  return run;
}

async function previewAudioNow() {
  const proj = requireProject();
  const st = await proj.state();
  const total = st.doc.settings.durationSec;
  const plan = planAudioMix(st.doc.timeline.tracks, total);
  if (plan.inputs.length === 0) return { file: null, durationSec: total };
  const audioFiles = plan.inputs.map((input) => resolveAudioSource(proj, st.doc, input.source));
  const stats = await Promise.all(audioFiles.map((f) => fs.stat(f)));
  const identity = { filter: plan.filter, total, files: audioFiles.map((f, i) => [f, stats[i].size, stats[i].mtimeMs]) };
  const stamp = createHash('sha1').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
  const name = `preview-${stamp}.wav`;
  const target = await proj.audioTarget(`audio/${name}`); // a path inside the project, in its audio folder
  if (!(await fs.stat(target).then(() => true, () => false))) {
    const ff = await resolveFfmpeg();
    if (!ff) throw new ProjectError('FFmpeg was not found, so the preview cannot play sound. Install FFmpeg, or choose its location in the Render section of the Inspector.');
    const part = target + '.part';
    await runFfmpeg(ff.path, mixArgs({ audioFiles, filter: plan.filter, outFile: part, durationSec: total }));
    await fs.rename(part, target);
  }
  for (const old of await fs.readdir(path.dirname(target)).catch(() => [])) {
    if (/^preview-.*\.wav(\.part)?$/.test(old) && old !== name) await fs.rm(path.join(path.dirname(target), old), { force: true }).catch(() => {});
  }
  return { file: `audio/${name}`, durationSec: total };
}

/** The paint calls of the animation at a time (the parts the studio can pick), for the studio's list. */
async function listParts({ timeMs }) {
  const proj = requireProject();
  const st = await proj.state();
  const comp = await ensureCompPreview(proj, st.doc);
  const { animMs, state } = compositionFrame(st.doc, Math.max(0, Number(timeMs) || 0) / 1000);
  await comp.frame(animMs, state); // draw the time first, so the list is of that frame
  return comp.ops();
}

/**
 * The stretch of the video (seconds) in which a part is the same part as at `timeSec`: the paint call with this number
 * and key, in the frames around it, while it keeps its place (its box moves by less than its own size and 80 px between
 * two frames a second apart). The two edges are found to the frame by halving. Null when the part is not drawn then.
 */
async function partWindow({ timeSec, index, key }) {
  const proj = requireProject();
  const st = await proj.state();
  const comp = await ensureCompPreview(proj, st.doc);
  const fps = st.doc.settings.fps || 30;
  const total = st.doc.settings.durationSec;
  const at = Math.min(total, Math.max(0, Number(timeSec) || 0));
  // A sample is the part at that time (or null) and the whole frame it is in (for the scene test).
  const sample = async (sec) => {
    const { animMs, state } = compositionFrame(st.doc, sec);
    await comp.frame(animMs, state);
    const ops = await comp.ops();
    return { op: ops.find((o) => o.index === Number(index) && o.key === key && o.bbox) ?? null, ops };
  };
  const seedSample = await sample(at);
  if (!seedSample.op) return null;
  const seed = seedSample.op;
  const size = (o) => Math.max(o.bbox[2] - o.bbox[0], o.bbox[3] - o.bbox[1]);
  const centre = (o) => [(o.bbox[0] + o.bbox[2]) / 2, (o.bbox[1] + o.bbox[3]) / 2];
  const same = (a, b) => {
    const [ax, ay] = centre(a);
    const [bx, by] = centre(b);
    return Math.hypot(ax - bx, ay - by) <= Math.max(size(a), size(b)) + 80;
  };
  // One edge: walk away from the pick one second at a time while the part is the same part in the same scene; then halve
  // between the last frame where it is and the first where it is not. Returns the last time the part is there. A scene
  // cut ends the stretch even when the next scene draws a part of the same kind in the same place (sameScene).
  const edge = async (dir) => {
    let good = at;
    let goodOp = seed;
    let goodOps = seedSample.ops;
    let bad = null;
    for (let k = 1; ; k++) {
      const sec = at + dir * k;
      if (sec < 0 || sec > total) break; // the start or the end of the video
      const s = await sample(sec);
      if (!s.op || !same(goodOp, s.op) || !sameScene(goodOps, s.ops)) {
        bad = sec;
        break;
      }
      good = sec;
      goodOp = s.op;
      goodOps = s.ops;
    }
    if (bad === null) return dir < 0 ? 0 : total;
    let lo = good;
    let hi = bad;
    while (Math.abs(hi - lo) > 1 / fps + 1e-9) {
      const mid = (lo + hi) / 2;
      const s = await sample(mid);
      if (s.op && same(goodOp, s.op) && sameScene(goodOps, s.ops)) {
        lo = mid;
        goodOp = s.op;
        goodOps = s.ops;
      } else {
        hi = mid;
      }
    }
    return lo;
  };
  const back = await edge(-1);
  const front = await edge(1);
  const frame = (v) => Math.round(v * fps) / fps;
  return { t0: frame(Math.min(back, at)), t1: frame(Math.max(front, at)) };
}

// The animation's own window, for developer tools. The preview's render page is never shown, so its tools cannot be
// docked; this window shows the animation as it plays (live), with the tools docked to it.
let animationWindow = null;
let animationWindowAsset = null;

/** Opens the animation's page in its own window with developer tools (needs an open project with an animation). */
async function openAnimationDevtools() {
  if (!current) return false;
  const st = await current.state();
  const clip = htmlClipOf(st.doc);
  const base = clip ? st.doc.assets.find((a) => a.id === clip.assetId) : null;
  if (!base) throw new ProjectError('There is no HTML animation in the project.');
  if (!animationWindow || animationWindow.isDestroyed() || animationWindowAsset !== base.id) {
    if (animationWindow && !animationWindow.isDestroyed()) animationWindow.destroy();
    const { width, height } = frameSize(st.doc.settings);
    const scale = Math.min(1, 520 / width);
    animationWindow = new BrowserWindow({
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      title: `Animation: ${base.name}`,
      backgroundColor: '#ffffff',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    animationWindowAsset = base.id;
    animationWindow.on('closed', () => {
      animationWindow = null;
      animationWindowAsset = null;
    });
    await animationWindow.loadURL(assetAddress(base));
  }
  animationWindow.webContents.openDevTools({ mode: 'right' });
  animationWindow.focus();
  // The tools open after a moment; report once they are open (or it is clear they are not).
  const wc = animationWindow.webContents;
  for (let i = 0; i < 20 && !wc.isDevToolsOpened(); i++) await new Promise((r) => setTimeout(r, 100));
  return wc.isDevToolsOpened();
}

function setFullScreen(on) {
  if (win && !win.isDestroyed()) win.setFullScreen(Boolean(on));
}

/** The file behind one audio input of the mix: a narration segment, or a music file from the library. */
function resolveAudioSource(proj, doc, source) {
  if (source.type === 'segment') {
    const seg = doc.narration?.segments.find((x) => x.id === source.id);
    if (!seg || seg.status !== 'ok' || !seg.file) throw new ProjectError('A narration segment has no audio yet. Generate the narration first.');
    const file = proj.fileInside(seg.file);
    if (!file || !existsSync(file)) throw new ProjectError(`The audio of narration segment ${seg.index} is missing from the project.`);
    return file;
  }
  const asset = doc.assets.find((a) => a.id === source.id);
  if (!asset || asset.kind !== 'audio') throw new ProjectError('A music clip refers to a file that is no longer in the project.');
  const file = proj.assetFile(asset.id);
  if (!file || !existsSync(file)) throw new ProjectError(`The audio file "${asset.name}" is missing from the project.`);
  return file;
}

async function exportComposition({ fps, durationSec }) {
  if (exportJob) throw new ProjectError('A video is already being exported. Wait for it to finish or cancel it.');
  const proj = requireProject();
  const st = await proj.state();
  const f = Number(fps ?? st.doc.settings.fps);
  const d = Number(durationSec ?? st.doc.settings.durationSec);
  if (!FPS_OPTIONS.includes(f)) throw new ProjectError('Frame rate must be 30 or 60 fps.');
  if (!(d >= MIN_DURATION_SEC && d <= MAX_DURATION_SEC)) {
    throw new ProjectError(`Duration must be between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC} seconds.`);
  }
  const ff = await resolveFfmpeg();
  if (!ff) throw new ProjectError('FFmpeg was not found. Install FFmpeg, or choose its location in the Render section of the Inspector.');

  // The audio is planned and its files checked before any frame is drawn.
  const plan = planAudioMix(st.doc.timeline.tracks, d);
  const audioFiles = plan.inputs.map((input) => resolveAudioSource(proj, st.doc, input.source));

  const fileName = `timeline-${f}fps-${stamp()}.mp4`;
  const outFile = await proj.renderTarget(fileName);
  const videoFile = plan.inputs.length > 0 ? await proj.renderTarget(`.video-${randomBytes(4).toString('hex')}.mp4`) : outFile;
  const id = nextJobId++;
  const controller = new AbortController();
  exportJob = { id, controller };
  try {
    const result = await renderVideo({
      openSession: async () => {
        const session = await openComposition(st.doc);
        return {
          frame: (tMs) => {
            const { animMs, state } = compositionFrame(st.doc, tMs / 1000);
            return session.frame(animMs, state);
          },
          close: () => session.close(),
          warnings: session.warnings,
        };
      },
      outFile: videoFile,
      ffmpegPath: ff.path,
      fps: f,
      durationSec: d,
      mode: 'deterministic',
      signal: controller.signal,
      onProgress: (p) => win?.webContents.send('render:progress', { id, ...p }),
    });
    if (plan.inputs.length > 0) {
      try {
        await runFfmpeg(ff.path, muxArgs({ videoFile, audioFiles, filter: plan.filter, outFile, durationSec: d }));
      } finally {
        await fs.rm(videoFile, { force: true }).catch(() => {});
      }
    }
    const st2 = await fs.stat(outFile);
    const record = {
      id: 'r_' + randomBytes(5).toString('hex'),
      assetId: null,
      kind: 'timeline',
      file: `renders/${fileName}`,
      fps: f,
      durationSec: d,
      mode: 'deterministic',
      frames: result.frames,
      bytes: st2.size,
      audioClips: plan.inputs.length,
      createdAt: new Date().toISOString(),
    };
    await proj.addRender(record);
    return { id, render: record, warnings: result.warnings, state: await proj.state() };
  } catch (err) {
    if (err instanceof RenderCancelled) throw new ProjectError('The export was cancelled. The partial file was removed.');
    throw err;
  } finally {
    exportJob = null;
  }
}

// ---------- IPC ----------

function registerIpc() {
  handle('app:info', () => ({ name: app.getName(), version: app.getVersion(), e2e: E2E, platform: process.platform }));

  handle('recent:list', () => recent.list());
  handle('recent:remove', ({ dir }) => recent.remove(String(dir)));

  handle('dialog:pickFolder', async ({ title }) => {
    if (E2E) return picks.folder ?? null;
    const r = await dialog.showOpenDialog(win, {
      title: title || 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('dialog:pickFiles', async () => {
    if (E2E) return picks.files ?? [];
    const r = await dialog.showOpenDialog(win, {
      title: 'Import files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Supported files', extensions: SUPPORTED_EXTENSIONS.map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });

  handle('project:create', async ({ parentDir, name, settings: s }) => {
    const proj = await createProject({ parentDir: String(parentDir), name, settings: s });
    current = proj;
    await recent.add({ dir: proj.dir, name: proj.name });
    return stateOf();
  });

  handle('project:open', async ({ dir }) => {
    const proj = await openProject(String(dir));
    await enqueuePreview(() => closePreview());
    current = proj;
    await recent.add({ dir: proj.dir, name: proj.name });
    return stateOf();
  });

  handle('project:close', async () => {
    await enqueuePreview(() => closePreview());
    current = null;
    return null;
  });

  handle('project:state', () => stateOf());
  handle('project:save', async () => {
    await requireProject().save();
    return stateOf();
  });
  handle('project:updateSettings', async (patch) => {
    await requireProject().updateSettings(patch);
    await enqueuePreview(() => closePreview());
    return stateOf();
  });
  handle('project:rename', async ({ name }) => {
    await requireProject().rename(name);
    return stateOf();
  });
  handle('project:reveal', async () => {
    const err = await shell.openPath(requireProject().dir);
    if (err) throw new ProjectError(err);
    return true;
  });

  handle('assets:import', async ({ paths, folderId }) => {
    if (!Array.isArray(paths)) throw new ProjectError('No files were given.');
    const proj = requireProject();
    const { results } = await proj.importFiles(paths.map(String), folderId ?? null);
    return { results, state: await proj.state() };
  });
  handle('assets:remove', async ({ id }) => {
    await enqueuePreview(() => closePreview());
    await requireProject().removeAsset(String(id));
    return stateOf();
  });
  handle('assets:rename', async ({ id, name }) => {
    await requireProject().renameAsset(String(id), name);
    return stateOf();
  });
  handle('assets:move', async ({ id, folderId }) => {
    await requireProject().moveAsset(String(id), folderId ?? null);
    return stateOf();
  });
  handle('assets:readText', async ({ id }) => requireProject().readText(String(id)));
  handle('assets:writeText', async ({ id, text }) => {
    await requireProject().writeText(String(id), String(text ?? ''));
    return stateOf();
  });
  handle('assets:restoreOriginal', async ({ id }) => {
    await requireProject().restoreOriginal(String(id));
    return stateOf();
  });

  // Example project (opens by itself on the first start; the button on the start screen opens it again)
  handle('example:start', async () => {
    if (!AUTO_EXAMPLE || current) return null;
    const saved = await settings.read();
    if (saved.autoExampleDone) return null;
    await settings.update({ autoExampleDone: true });
    return openExample();
  });
  handle('example:open', () => openExample());

  handle('app:masterPrompt', () => readMasterPrompt());
  handle('window:setFullScreen', ({ on }) => {
    setFullScreen(Boolean(on));
    return win ? win.isFullScreen() : false;
  });
  handle('assets:renderOptions', async ({ id, ...options }) => {
    // Every option the page sends is kept (the mode, the hidden elements and the moved elements); unknown ones are ignored.
    await requireProject().setRenderOptions(String(id), options);
    // The asset's own preview session is reopened with the new options. The composition page is not closed here: it
    // reopens by itself when its inputs change, and closing it while a frame is drawn fails that frame. Queued like the
    // other frame work.
    await enqueuePreview(async () => {
      const s = preview?.session;
      preview = null;
      if (s) await s.close();
    });
    return stateOf();
  });

  handle('folders:create', async ({ name }) => {
    await requireProject().createFolder(name);
    return stateOf();
  });
  handle('folders:rename', async ({ id, name }) => {
    await requireProject().renameFolder(String(id), name);
    return stateOf();
  });
  handle('folders:delete', async ({ id }) => {
    await requireProject().deleteFolder(String(id));
    return stateOf();
  });

  handle('render:preview', ({ assetId, timeMs }) => enqueuePreview(() => previewFrame({ assetId: String(assetId), timeMs })));
  handle('render:closePreview', () => enqueuePreview(() => closePreview()).then(() => true));
  handle('render:export', (p) => exportVideo(p));
  handle('render:cancel', ({ id }) => {
    if (!exportJob || exportJob.id !== Number(id)) return false;
    exportJob.controller.abort();
    return true;
  });
  handle('render:reveal', async ({ file }) => {
    const proj = requireProject();
    const abs = proj.fileInside(String(file));
    if (!abs) throw new ProjectError('That file is not part of this project.');
    shell.showItemInFolder(abs);
    return true;
  });

  handle('ffmpeg:status', () => resolveFfmpeg());
  handle('ffmpeg:choose', async () => {
    let file = null;
    if (E2E) file = picks.ffmpeg ?? null;
    else {
      const r = await dialog.showOpenDialog(win, {
        title: 'Find ffmpeg',
        properties: ['openFile'],
        filters: [{ name: 'FFmpeg', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }],
      });
      file = r.canceled ? null : r.filePaths[0];
    }
    if (!file) return null;
    const version = await probeFfmpeg(file);
    if (!version) throw new ProjectError('That file is not a working FFmpeg program.');
    await settings.update({ ffmpegPath: file });
    return { path: file, source: 'settings', version };
  });

  handle('tts:voices', () => voiceCatalog());
  handle('tts:status', () => ttsStatus());
  handle('tts:choosePython', async () => {
    let file = null;
    if (E2E) file = picks.python ?? null;
    else {
      const r = await dialog.showOpenDialog(win, {
        title: 'Find python.exe (the one with Kokoro installed)',
        properties: ['openFile'],
        filters: [{ name: 'Python', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }],
      });
      file = r.canceled ? null : r.filePaths[0];
    }
    if (!file) return null;
    if (!probePython(file)) throw new ProjectError('That file is not a working Python program.');
    await settings.update({ pythonPath: file });
    engine?.stop('The narration engine was switched.');
    engine = null;
    return ttsStatus();
  });

  handle('narration:set', async (p) => {
    await requireProject().setNarration(p);
    return stateOf();
  });
  handle('narration:settings', async (p) => {
    await requireProject().setNarrationSettings(p);
    return stateOf();
  });
  handle('narration:edit', async ({ id, text }) => {
    await requireProject().editSegment(String(id), text);
    return stateOf();
  });
  handle('narration:clear', async () => {
    await requireProject().clearNarration();
    return stateOf();
  });
  handle('narration:generate', async ({ segmentIds }) => {
    if (narrationJob) throw new ProjectError('Narration is already being generated.');
    const controller = new AbortController();
    narrationJob = { controller };
    try {
      const result = await generateNarration(
        { segmentIds: Array.isArray(segmentIds) ? segmentIds.map(String) : null },
        controller.signal,
        (p) => win?.webContents.send('narration:progress', p),
      );
      return result;
    } finally {
      narrationJob = null;
    }
  });
  handle('narration:cancel', () => {
    if (!narrationJob) return false;
    narrationJob.controller.abort();
    engine?.stop('The narration was cancelled.');
    return true;
  });
  handle('narration:preview', (p) => previewVoice(p));

  handle('timeline:save', async ({ tracks }) => {
    if (!Array.isArray(tracks)) throw new ProjectError('No timeline was given.');
    await requireProject().setTimeline(tracks);
    return stateOf();
  });
  handle('render:composition', ({ timeMs }) => enqueuePreview(() => previewComposition({ timeMs })));
  handle('composition:inspect', (p) => enqueuePreview(() => inspectComposition(p ?? {})));
  handle('preview:audio', () => previewAudio());
  handle('composition:parts', (p) => enqueuePreview(() => listParts(p ?? {})));
  handle('composition:partWindow', (p) => enqueuePreview(() => partWindow(p ?? {})));
  handle('render:exportComposition', (p) => exportComposition(p));

  // Queued with the other frame requests: the render page is shared, and closing it while a frame is drawn fails that frame.
  handle('e2e:ops', ({ timeMs } = {}) => {
    if (!E2E) throw new ProjectError('Test hooks are disabled.');
    return enqueuePreview(async () => {
      const proj = requireProject();
      const st = await proj.state();
      const comp = await ensureCompPreview(proj, st.doc);
      const { animMs, state } = compositionFrame(st.doc, Math.max(0, Number(timeMs) || 0) / 1000);
      await comp.frame(animMs, state);
      return comp.ops();
    });
  });
  handle('e2e:animationDevtools', async () => {
    if (!E2E) throw new ProjectError('Test hooks are disabled.');
    return openAnimationDevtools(); // true when the developer tools of the animation's page are open
  });
  handle('e2e:windows', () => {
    if (!E2E) throw new ProjectError('Test hooks are disabled.');
    return BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible(), fullScreen: w.isFullScreen() }));
  });
  handle('e2e:setPicks', (p) => {
    if (!E2E) throw new ProjectError('Test hooks are disabled.');
    if ('folder' in p) picks.folder = p.folder;
    if ('files' in p) picks.files = p.files;
    if ('ffmpeg' in p) picks.ffmpeg = p.ffmpeg;
    if ('python' in p) picks.python = p.python;
    return true;
  });
}

/** The master prompt (electron/assets/master-prompt.md): a description of how the app works, to read and to copy. */
async function readMasterPrompt() {
  return fs.readFile(path.join(here, 'assets', 'master-prompt.md'), 'utf8');
}

async function copyMasterPrompt() {
  clipboard.writeText(await readMasterPrompt());
}

function buildMenu() {
  const send = (action) => win?.webContents.send('menu:action', action);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New project…', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'Open project…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Import files…', accelerator: 'CmdOrCtrl+I', click: () => send('import') },
        { type: 'separator' },
        { label: 'Save now', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Show project folder', click: () => send('reveal') },
        { label: 'Close project', click: () => send('close') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        // F11 and Escape also work; the menu item shows the state and can always be used to leave full screen.
        { label: win?.isFullScreen() ? 'Leave full screen (F11 or Esc)' : 'Full screen (F11)', click: () => setFullScreen(!win?.isFullScreen()) },
        { label: 'Minimize', click: () => win?.minimize() },
        { type: 'separator' },
        // The app's own developer tools show the app's layout. This one shows the animation's page, which is what the
        // preview is drawn from: its DOM (the elements), its CSS and its script.
        { label: 'Developer tools for the animation', click: () => void openAnimationDevtools() },
        { role: 'toggleDevTools', label: 'Developer tools for the app' },
      ],
    },
    { label: 'Master prompt', submenu: [
      { label: 'Show the master prompt', click: () => send('master') },
      { label: 'Copy the master prompt', click: () => void copyMasterPrompt() },
    ] },
    { label: 'Help', submenu: [{ label: 'About VierVideo', click: () => send('about') }] },
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1180,
    minHeight: 700,
    title: 'VierVideo',
    backgroundColor: '#f6f8fa',
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const appOrigin = DEV_URL || 'vvapp://app/';
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appOrigin)) event.preventDefault();
  });
  win.on('closed', () => {
    win = null;
  });
  // The preview zooms with Ctrl+wheel and pinch; the page itself must not zoom.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  const fullScreenChanged = () => {
    win?.webContents.send('window:fullscreen', win.isFullScreen());
    buildMenu();
  };
  win.on('enter-full-screen', fullScreenChanged);
  win.on('leave-full-screen', fullScreenChanged);
  // F11 toggles full screen and Escape leaves it. Both work even when the menu is hidden.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      event.preventDefault();
      setFullScreen(!win.isFullScreen());
    } else if (input.key === 'Escape' && win.isFullScreen()) {
      event.preventDefault();
      setFullScreen(false);
    }
  });
  win.loadURL(DEV_URL || 'vvapp://app/index.html');
}

if (gotLock) {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    exportJob?.controller.abort();
    narrationJob?.controller.abort();
    engine?.stop('The app is closing.');
    void closePreview();
  });
  app.whenReady().then(() => {
    recent = new RecentProjects(path.join(app.getPath('userData'), 'recent-projects.json'));
    settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    registerProtocols();
    registerIpc();
    buildMenu();
    createWindow();
  });
}
