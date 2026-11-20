// Shared by the Electron main process and the renderer: project file format,
// aspect presets, track layout and file-kind detection. Pure functions only.

/** @typedef {'9:16'|'16:9'|'1:1'} AspectId */
/** @typedef {'image'|'svg'|'html'|'script'|'audio'|'video'} AssetKind */

import { DEFAULT_SPEED, DEFAULT_VOICE, SEGMENT_STATUS, VOICE_IDS, clampSpeed } from './narration.mjs';
import { normalizeTracks } from './timeline.mjs';

export const FORMAT = 'viervideo-project';
export const FORMAT_VERSION = 1;
export const PROJECT_FILE = 'project.vvproj.json';
export const ASSET_DIR = 'assets';
export const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
export const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024;

export const ASPECTS = [
  { id: '9:16', label: 'Vertical 9:16 (Reels, Shorts, TikTok)', width: 1080, height: 1920 },
  { id: '16:9', label: 'Landscape 16:9 (YouTube)', width: 1920, height: 1080 },
  { id: '1:1', label: 'Square 1:1 (feed posts)', width: 1080, height: 1080 },
];
export const FPS_OPTIONS = [30, 60];
export const MIN_DURATION_SEC = 1;
export const MAX_DURATION_SEC = 600;
export const DEFAULT_SETTINGS = { aspect: '9:16', fps: 30, durationSec: 60 };

/** Timeline tracks. Clips are added in a later stage; the empty tracks are part of the file format now. */
export const TRACKS = [
  { id: 'html', name: 'HTML animation', kinds: ['html'] },
  { id: 'visual', name: 'Images & graphics', kinds: ['image', 'svg', 'video'] },
  { id: 'text', name: 'Text & captions', kinds: [] },
  { id: 'narration', name: 'Narration', kinds: ['audio'] },
  { id: 'music', name: 'Music & sound effects', kinds: ['audio'] },
];

const KIND_BY_EXT = {
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.svg': { kind: 'svg', mime: 'image/svg+xml' },
  '.html': { kind: 'html', mime: 'text/html' },
  '.htm': { kind: 'html', mime: 'text/html' },
  '.md': { kind: 'script', mime: 'text/markdown' },
  '.markdown': { kind: 'script', mime: 'text/markdown' },
  '.txt': { kind: 'script', mime: 'text/plain' },
  '.json': { kind: 'script', mime: 'application/json' },
  '.csv': { kind: 'script', mime: 'text/csv' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
};

/** Text-based kinds whose content can be previewed as text. */
// Kinds whose text can be read (and, for html, edited as code). Script files are read only.
export const TEXT_KINDS = ['script', 'html'];

/** @returns {{kind: AssetKind, mime: string, ext: string} | null} */
export function kindForFileName(name) {
  const dot = String(name).lastIndexOf('.');
  if (dot < 0) return null;
  const ext = String(name).slice(dot).toLowerCase();
  const hit = KIND_BY_EXT[ext];
  return hit ? { ...hit, ext } : null;
}

export const SUPPORTED_EXTENSIONS = Object.keys(KIND_BY_EXT);

export const KIND_LABEL = {
  image: 'Image',
  svg: 'SVG',
  html: 'HTML animation',
  script: 'Script',
  audio: 'Audio',
  video: 'Video',
};

export function aspectById(id) {
  return ASPECTS.find((a) => a.id === id) ?? null;
}

export function frameSize(settings) {
  const a = aspectById(settings.aspect);
  if (!a) throw new Error(`Unknown aspect ratio: ${settings.aspect}`);
  return { width: a.width, height: a.height };
}

/**
 * Validate and normalise project settings. Throws a readable Error on bad input.
 * @param {any} input
 */
export function normalizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input ?? {}) };
  if (!aspectById(s.aspect)) throw new Error(`Aspect ratio must be one of ${ASPECTS.map((a) => a.id).join(', ')}.`);
  if (!FPS_OPTIONS.includes(Number(s.fps))) throw new Error('Frame rate must be 30 or 60 fps.');
  const dur = Number(s.durationSec);
  if (!Number.isFinite(dur) || dur < MIN_DURATION_SEC || dur > MAX_DURATION_SEC) {
    throw new Error(`Duration must be between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC} seconds.`);
  }
  return { aspect: s.aspect, fps: Number(s.fps), durationSec: Math.round(dur * 100) / 100 };
}

/** How an HTML animation is rendered: 'deterministic' drives its clock frame by frame; 'realtime' records it as it plays. */
export const RENDER_MODES = ['deterministic', 'realtime'];
export const DEFAULT_HIDE_SELECTORS = '#controls, #bar';

/** Render options of one HTML asset. Missing values take the defaults. */
export function normalizeRenderOptions(input) {
  const r = input ?? {};
  const mode = r.mode ?? 'deterministic';
  if (!RENDER_MODES.includes(mode)) throw new Error(`Render mode must be one of ${RENDER_MODES.join(', ')}.`);
  const hideSelectors = String(r.hideSelectors ?? DEFAULT_HIDE_SELECTORS)
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 300);
  // Elements of the animation moved in the studio: a path to the element (as the studio finds it), the element's tag and
  // id (the offset applies only while the element at that path still is this one), and its offset in frame pixels.
  // A zero offset is the same as no entry, and an entry without a tag is from before that check: it is dropped.
  const elementOffsets = (Array.isArray(r.elementOffsets) ? r.elementOffsets : [])
    .slice(0, 200)
    .map((o) => ({
      selector: String(o?.selector ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 400),
      tag: String(o?.tag ?? '').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase().slice(0, 40),
      id: String(o?.id ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120),
      x: Math.max(-4000, Math.min(4000, Number(o?.x) || 0)),
      y: Math.max(-4000, Math.min(4000, Number(o?.y) || 0)),
    }))
    .filter((o) => o.selector && o.tag && (o.x || o.y));
  // Parts of a canvas-drawn animation moved in the studio. A part is a paint call, and its number is only meaningful
  // within one scene: the same number is another paint call in another scene (see canvas-recorder.mjs). So a move keeps
  // the part's identity (`key`: kind, colour and text) and the stretch of the video where it is the same part (t0 to t1,
  // seconds). A move without that window is from before this check and is dropped. A zero offset is dropped too.
  const seen = new Map();
  for (const o of (Array.isArray(r.opOffsets) ? r.opOffsets : []).slice(0, 300)) {
    const entry = partEntry(o);
    // A move that changes nothing is dropped. The same part in the same stretch: the last one wins.
    if (entry && !isIdentityPart(entry)) seen.set(`${entry.index}|${entry.key}|${entry.t0}|${entry.t1}`, entry);
  }
  const opOffsets = [...seen.values()];
  // Parts grouped in the studio: which part (its number, key and stretch) belongs to which group.
  const partGroups = [];
  const groupSeen = new Set();
  for (const g of (Array.isArray(r.partGroups) ? r.partGroups : []).slice(0, 500)) {
    const part = partEntry({ ...g, dx: 0, dy: 0, sx: 1, sy: 1 });
    const group = String(g?.group ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (!part || !group) continue;
    const id = `${group}|${part.index}|${part.key}|${part.t0}|${part.t1}`;
    if (groupSeen.has(id)) continue;
    groupSeen.add(id);
    partGroups.push({ group, index: part.index, kind: part.kind, text: part.text, key: part.key, t0: part.t0, t1: part.t1 });
  }
  return { mode, hideSelectors, elementOffsets, opOffsets, partGroups };
}

/** One canvas part's entry, cleaned: its number, what it is, its stretch of the video and its transform. Null when it is not valid. */
function partEntry(o) {
  const index = Math.max(0, Math.min(1000000, Math.round(Number(o?.index)) || 0));
  const key = String(o?.key ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 120);
  const t0 = Number(o?.t0);
  const t1 = Number(o?.t1);
  if (!key || !Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return null;
  const entry = {
    index,
    kind: String(o?.kind ?? '').slice(0, 20),
    text: String(o?.text ?? '').slice(0, 40),
    key,
    t0: Math.max(0, Math.min(3600, t0)),
    t1: Math.max(0, Math.min(3600, t1)),
    sx: Math.max(0.05, Math.min(20, Number.isFinite(Number(o?.sx)) ? Number(o.sx) : 1)),
    sy: Math.max(0.05, Math.min(20, Number.isFinite(Number(o?.sy)) ? Number(o.sy) : 1)),
    dx: Math.max(-4000, Math.min(4000, Number(o?.dx) || 0)),
    dy: Math.max(-4000, Math.min(4000, Number(o?.dy) || 0)),
  };
  return entry;
}

/** A part's transform that changes nothing: the part is drawn where and as the animation draws it. */
export function isIdentityPart(t) {
  return t.sx === 1 && t.sy === 1 && t.dx === 0 && t.dy === 0;
}

/**
 * Applies a transform to a canvas part, in the stretch of the video given: the part's transform so far is composed with
 * the new one (first the old, then the new). Returns the new list of moves. `part` is {index, key, kind, text}; `win` is
 * {t0, t1}; `t` is {sx, sy, dx, dy}, a point (x, y) of the part going to (sx x + dx, sy y + dy).
 */
export function composePartOffsets(opOffsets, part, win, t) {
  const list = Array.isArray(opOffsets) ? opOffsets : [];
  const hits = list.filter((o) => o.index === part.index && o.key === part.key && o.t1 >= win.t0 && o.t0 <= win.t1);
  let total = { sx: 1, sy: 1, dx: 0, dy: 0 };
  for (const o of hits) total = composeTransforms(total, { sx: o.sx ?? 1, sy: o.sy ?? 1, dx: o.dx, dy: o.dy });
  total = composeTransforms(total, { sx: t.sx, sy: t.sy, dx: t.dx, dy: t.dy });
  const t0 = Math.min(win.t0, ...hits.map((o) => o.t0));
  const t1 = Math.max(win.t1, ...hits.map((o) => o.t1));
  const entry = { index: part.index, kind: part.kind, text: part.text, key: part.key, t0, t1, ...total };
  return [...list.filter((o) => !hits.includes(o)), entry].filter((o) => !isIdentityPart(o));
}

/** The transform that applies `a` first, then `b`. */
export function composeTransforms(a, b) {
  return { sx: a.sx * b.sx, sy: a.sy * b.sy, dx: b.sx * a.dx + b.dx, dy: b.sy * a.dy + b.dy };
}

/**
 * The part offsets that apply at a time (seconds of the project). Only those whose stretch of the video contains the
 * time are sent to the render page: outside its stretch, a paint call with the same number is another part.
 */
export function activeOpOffsets(opOffsets, timeSec) {
  const t = Number(timeSec) || 0;
  return (Array.isArray(opOffsets) ? opOffsets : []).filter(
    (o) => Number.isFinite(o?.t0) && Number.isFinite(o?.t1) && t >= o.t0 - 1e-6 && t <= o.t1 + 1e-6,
  );
}

export function cleanName(name, max = 120) {
  const s = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  if (!s) throw new Error('Please enter a name.');
  if (s.length > max) throw new Error(`Names can be at most ${max} characters.`);
  return s;
}

export function newId(prefix) {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

/** Narration of the project: null, or the script it came from, the voice and speed, and the segments. */
export function normalizeNarration(n) {
  if (n == null) return null;
  if (typeof n !== 'object') throw new Error('The narration data is malformed.');
  const voice = VOICE_IDS.includes(n.voice) ? n.voice : DEFAULT_VOICE;
  const segments = (Array.isArray(n.segments) ? n.segments : []).map((s) => {
    if (!s || typeof s.id !== 'string' || typeof s.text !== 'string') throw new Error('A narration segment is malformed.');
    const status = SEGMENT_STATUS.includes(s.status) ? s.status : 'pending';
    const file = typeof s.file === 'string' && s.file.startsWith('audio/') && !s.file.includes('..') ? s.file : null;
    return {
      id: s.id,
      index: Number(s.index) || 0,
      start: typeof s.start === 'number' ? s.start : null,
      end: typeof s.end === 'number' ? s.end : null,
      text: s.text.slice(0, 2000),
      status: file || status !== 'ok' ? status : 'pending',
      file,
      durationSec: typeof s.durationSec === 'number' ? s.durationSec : null,
      signature: typeof s.signature === 'string' ? s.signature : null,
      error: typeof s.error === 'string' ? s.error.slice(0, 500) : null,
    };
  });
  return {
    sourceAssetId: typeof n.sourceAssetId === 'string' ? n.sourceAssetId : null,
    voice,
    speed: clampSpeed(n.speed ?? DEFAULT_SPEED),
    segments,
  };
}

/**
 * Validate a parsed project document. Returns it (with defaults filled) or throws.
 * Asset file paths must stay inside the assets folder.
 * @param {any} doc
 */
export function validateProjectDoc(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('The project file is not a JSON object.');
  if (doc.format !== FORMAT) throw new Error('This file is not a VierVideo project.');
  if (typeof doc.version !== 'number' || doc.version > FORMAT_VERSION) {
    throw new Error(`This project was made by a newer version of VierVideo (format ${doc.version}).`);
  }
  if (typeof doc.id !== 'string' || !doc.id) throw new Error('The project file has no id.');
  const name = cleanName(doc.name);
  const settings = normalizeSettings(doc.settings);

  const folders = Array.isArray(doc.folders) ? doc.folders : [];
  for (const f of folders) {
    if (!f || typeof f.id !== 'string' || typeof f.name !== 'string') throw new Error('A folder entry is malformed.');
  }
  const folderIds = new Set(folders.map((f) => f.id));

  const assets = Array.isArray(doc.assets) ? doc.assets : [];
  for (const a of assets) {
    if (!a || typeof a.id !== 'string' || typeof a.name !== 'string') throw new Error('An asset entry is malformed.');
    if (!kindForFileName('x' + (a.ext ?? ''))) throw new Error(`Asset "${a.name}" has an unsupported type.`);
    if (typeof a.file !== 'string' || !a.file.startsWith(ASSET_DIR + '/') || a.file.includes('..')) {
      throw new Error(`Asset "${a.name}" points outside the project.`);
    }
    if (typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new Error(`Asset "${a.name}" has no valid checksum.`);
    if (a.folderId != null && !folderIds.has(a.folderId)) a.folderId = null;
    if (a.render !== undefined) {
      if (a.kind !== 'html') throw new Error(`Asset "${a.name}" has render options but is not an HTML animation.`);
      a.render = normalizeRenderOptions(a.render);
    }
  }

  const renders = Array.isArray(doc.renders)
    ? doc.renders.filter((r) => r && typeof r.file === 'string' && r.file.startsWith('renders/') && !r.file.includes('..'))
    : [];

  const timeline = doc.timeline && Array.isArray(doc.timeline.tracks)
    ? { ...doc.timeline, tracks: normalizeTracks(doc.timeline.tracks) }
    : { tracks: TRACKS.map((t) => ({ id: t.id, name: t.name, clips: [] })) };

  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    id: doc.id,
    name,
    createdAt: doc.createdAt ?? new Date(0).toISOString(),
    updatedAt: doc.updatedAt ?? doc.createdAt ?? new Date(0).toISOString(),
    settings,
    folders: folders.map((f) => ({ id: f.id, name: cleanName(f.name, 60) })),
    assets,
    renders,
    narration: normalizeNarration(doc.narration),
    timeline,
  };
}

/**
 * True when two frames (a moment apart) are the same scene: most of the parts of the earlier frame are still drawn in the
 * later one, by kind, colour and text, however they were numbered or where they are. A scene cut changes most parts at
 * once. Used by partWindow (electron/main.mjs) to end a part's stretch of the video at a cut, even when the next scene
 * draws a part of the same kind in the same place.
 */
export function sameScene(prevOps, ops) {
  const before = Array.isArray(prevOps) ? prevOps : [];
  const after = Array.isArray(ops) ? ops : [];
  if (before.length === 0 || after.length === 0) return false;
  const left = new Map();
  for (const o of after) left.set(o.key, (left.get(o.key) ?? 0) + 1);
  let kept = 0;
  for (const o of before) {
    const n = left.get(o.key) ?? 0;
    if (n > 0) {
      kept++;
      left.set(o.key, n - 1);
    }
  }
  return kept / before.length >= 0.6;
}
