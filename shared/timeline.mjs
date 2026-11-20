// Timeline model: tracks, clips and the edit operations on them. Pure functions shared by the main process
// (validation, rendering) and the renderer (editing). Nothing here touches the DOM, Electron or the file system.
//
// Rules (Stage 4):
// - one HTML animation per project; it is the base of the picture and runs on its own clock inside its clip
// - layers (images, shapes, text) may overlap; later clips of a track are drawn above earlier ones
// - narration clips are derived from the script segments and are read-only here (they are edited in the
//   narration editor); music clips and layers are fully editable
// - times are seconds; positions and sizes are in pixels of the output frame

export const TRACK_IDS = ['html', 'visual', 'text', 'narration', 'music'];
export const TRACK_KINDS = {
  html: ['html'],
  visual: ['image', 'shape', 'snippet'],
  text: ['text'],
  narration: ['audio'],
  music: ['audio'],
};
export const CLIP_KINDS = ['html', 'image', 'shape', 'text', 'snippet', 'audio'];
/** The kinds that are layers: drawn over (or under) the animation, moved, resized, grouped and ordered. */
export const LAYER_KINDS = ['image', 'shape', 'text', 'snippet'];
export const SHAPES = ['rect', 'ellipse', 'line', 'arrow'];
export const ALIGNS = ['left', 'center', 'right'];
export const MIN_CLIP_SEC = 0.1;
export const MAX_CLIPS = 500;
export const MAX_TEXT = 2000;
export const MAX_SNIPPET = 20000;

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const num = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};
const hex = (v, fallback) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback);

export function newClipId() {
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  return 'c_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Visual properties shared by image, shape and text layers. */
function layerProps(p) {
  return {
    x: num(p.x, -5000, 5000, 0),
    y: num(p.y, -5000, 5000, 0),
    w: num(p.w, 1, 5000, 400),
    h: num(p.h, 1, 5000, 400),
    rotation: num(p.rotation, -360, 360, 0),
    opacity: num(p.opacity, 0, 1, 1),
    fadeIn: num(p.fadeIn, 0, 60, 0),
    fadeOut: num(p.fadeOut, 0, 60, 0),
    behind: Boolean(p.behind),
  };
}

/**
 * An HTML element imported as a layer, as text. Comments, scripts, frames, plugins and event attributes are removed, so
 * the element is drawn as it is written and runs no code of its own. Its styles stay inside its layer (a shadow root).
 */
export function sanitizeSnippet(text) {
  let s = String(text ?? '').slice(0, MAX_SNIPPET);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|iframe|object|applet|frameset|noscript)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<\/?(script|iframe|object|applet|frameset|noscript|embed|frame|meta|base|link)\b[^>]*>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/javascript\s*:/gi, 'blocked:');
  return s;
}

/** Clip with defaults for its kind. `extra` overrides the defaults. */
export function makeClip(kind, track, start, duration, extra = {}) {
  if (!CLIP_KINDS.includes(kind)) throw new Error(`Unknown clip kind "${kind}".`);
  const base = {
    id: extra.id ?? newClipId(),
    track,
    kind,
    start: round(Math.max(0, start)),
    duration: round(Math.max(MIN_CLIP_SEC, duration)),
    name: typeof extra.name === 'string' ? extra.name.slice(0, 120) : '',
  };
  if (kind === 'html') return normalizeClip({ ...base, assetId: extra.assetId ?? null, offset: num(extra.offset, 0, 1e6, 0) });
  if (kind === 'image') {
    return normalizeClip({ ...base, ...layerProps({ w: 400, h: 400, ...extra }), assetId: extra.assetId ?? null });
  }
  if (kind === 'shape') {
    return normalizeClip({
      ...base,
      ...layerProps({ x: 340, y: 800, w: 400, h: 200, ...extra }),
      shape: SHAPES.includes(extra.shape) ? extra.shape : 'rect',
      fill: hex(extra.fill, '#caebfb'),
      stroke: hex(extra.stroke, '#4570b6'),
      strokeWidth: num(extra.strokeWidth, 0, 200, 4),
    });
  }
  if (kind === 'text') {
    return normalizeClip({
      ...base,
      ...layerProps({ x: 90, y: 200, w: 900, h: 200, ...extra }),
      text: String(extra.text ?? 'Your text').slice(0, MAX_TEXT),
      fontSize: num(extra.fontSize, 8, 400, 72),
      fontWeight: [400, 500, 600, 700].includes(Number(extra.fontWeight)) ? Number(extra.fontWeight) : 600,
      color: hex(extra.color, '#231f20'),
      align: ALIGNS.includes(extra.align) ? extra.align : 'center',
    });
  }
  if (kind === 'snippet') {
    return normalizeClip({ ...base, ...layerProps({ x: 200, y: 300, w: 680, h: 680, ...extra }), html: sanitizeSnippet(extra.html) });
  }
  // audio: music clips (assetId) and narration clips (segmentId, read-only)
  return normalizeClip({
    ...base,
    assetId: extra.assetId ?? null,
    segmentId: extra.segmentId ?? null,
    volume: num(extra.volume, 0, 2, 1),
    fadeIn: num(extra.fadeIn, 0, 60, 0),
    fadeOut: num(extra.fadeOut, 0, 60, 0),
  });
}

/** Clamps every numeric property of a clip to its allowed range. */
export function normalizeClip(c) {
  const out = { ...c, start: round(Math.max(0, Number(c.start) || 0)), duration: round(Math.max(MIN_CLIP_SEC, Number(c.duration) || MIN_CLIP_SEC)) };
  // Layers that belong together (a group) are selected and moved as one: the group is a short id, or null.
  out.group = typeof c.group === 'string' && c.group ? c.group.slice(0, 40) : null;
  if (out.kind === 'html') out.offset = num(out.offset, 0, 1e6, 0);
  if (LAYER_KINDS.includes(out.kind)) Object.assign(out, layerProps(out));
  if (out.kind === 'snippet') out.html = sanitizeSnippet(out.html);
  if (out.kind === 'shape') {
    out.shape = SHAPES.includes(out.shape) ? out.shape : 'rect';
    out.fill = hex(out.fill, '#caebfb');
    out.stroke = hex(out.stroke, '#4570b6');
    out.strokeWidth = num(out.strokeWidth, 0, 200, 4);
  }
  if (out.kind === 'text') {
    out.text = String(out.text ?? '').slice(0, MAX_TEXT);
    out.fontSize = num(out.fontSize, 8, 400, 72);
    out.fontWeight = [400, 500, 600, 700].includes(Number(out.fontWeight)) ? Number(out.fontWeight) : 600;
    out.color = hex(out.color, '#231f20');
    out.align = ALIGNS.includes(out.align) ? out.align : 'center';
  }
  if (out.kind === 'audio') {
    out.volume = num(out.volume, 0, 2, 1);
    out.fadeIn = num(out.fadeIn, 0, 60, 0);
    out.fadeOut = num(out.fadeOut, 0, 60, 0);
  }
  return out;
}

/** Tracks as stored in a project file: every clip normalised, and the track id filled in when missing. */
export function normalizeTracks(tracks) {
  return tracks.map((t) => ({
    id: String(t.id),
    name: String(t.name ?? t.id),
    clips: (Array.isArray(t.clips) ? t.clips : []).map((c) => {
      const clip = { ...c, track: c.track ?? t.id };
      return CLIP_KINDS.includes(clip.kind) ? normalizeClip(clip) : clip;
    }),
  }));
}

export function isReadOnly(clip) {
  return clip.kind === 'audio' && Boolean(clip.segmentId);
}

export function trackById(tracks, id) {
  return tracks.find((t) => t.id === id) ?? null;
}

export function findClip(tracks, id) {
  for (const t of tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c;
  }
  return null;
}

function copyTracks(tracks) {
  return tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c })) }));
}

function requireClip(tracks, id) {
  const clip = findClip(tracks, id);
  if (!clip) throw new Error('That clip no longer exists.');
  if (isReadOnly(clip)) throw new Error('Narration clips are edited in the narration editor.');
  return clip;
}

/** The longest a clip may run (the safety limit for a trim that runs past the project's end). */
const MAX_CLIP_END_SEC = 3600;

function assertKindOnTrack(kind, trackId) {
  const allowed = TRACK_KINDS[trackId];
  if (!allowed) throw new Error(`Unknown track "${trackId}".`);
  if (!allowed.includes(kind)) throw new Error(`A ${kind} clip cannot go on the ${trackId} track.`);
}

function totalClips(tracks) {
  return tracks.reduce((n, t) => n + t.clips.length, 0);
}

/** Keeps a clip's start inside the project, when the project is long enough to hold it. */
function clampStart(start, duration, total) {
  return Math.max(0, Math.min(start, total - duration));
}

/** Adds a clip. The html track takes one animation only. */
export function addClip(tracks, clip, total) {
  const next = copyTracks(tracks);
  if (totalClips(next) >= MAX_CLIPS) throw new Error(`A project can have at most ${MAX_CLIPS} clips.`);
  assertKindOnTrack(clip.kind, clip.track);
  if (clip.kind === 'html' && next.some((t) => t.clips.some((c) => c.kind === 'html'))) {
    throw new Error('A project has one HTML animation. Delete the current one first.');
  }
  const track = trackById(next, clip.track);
  if (!track) throw new Error(`Unknown track "${clip.track}".`);
  const placed = normalizeClip({ ...clip, start: clampStart(clip.start, clip.duration, total) });
  track.clips.push(placed);
  return next;
}

/**
 * Moves a clip in time and, optionally, to another track of the same kind. A clip may run past the end of the
 * project: export and preview stop at the end, and the timeline grows to show the whole clip.
 * Narration clips move too (their start is kept with the script); their length is the audio's and cannot change.
 */
export function moveClip(tracks, id, { start, track } = {}, total) {
  const next = copyTracks(tracks);
  const clip = findClip(next, id);
  if (!clip) throw new Error('That clip no longer exists.');
  const from = trackById(next, clip.track);
  const to = track ?? clip.track;
  assertKindOnTrack(clip.kind, to);
  const target = trackById(next, to);
  if (!target) throw new Error(`Unknown track "${to}".`);
  from.clips = from.clips.filter((c) => c.id !== id);
  const moved = normalizeClip({ ...clip, track: to, start: Math.min(Math.max(0, Number(start ?? clip.start) || 0), MAX_CLIP_END_SEC - clip.duration) });
  target.clips.push(moved);
  return next;
}

/** Trims one end of a clip. An HTML clip keeps its animation in step (its offset moves with the start). */
export function trimClip(tracks, id, { edge, time }, total) {
  const next = copyTracks(tracks);
  const clip = requireClip(next, id);
  const end = clip.start + clip.duration;
  let start = clip.start;
  let newEnd = end;
  if (edge === 'start') start = Math.min(Math.max(0, time), end - MIN_CLIP_SEC);
  else if (edge === 'end') newEnd = Math.min(Math.max(time, clip.start + MIN_CLIP_SEC), MAX_CLIP_END_SEC);
  else throw new Error('Trim edge must be "start" or "end".');
  const patched = normalizeClip({
    ...clip,
    start,
    duration: newEnd - start,
    offset: clip.kind === 'html' ? clip.offset + (start - clip.start) : clip.offset,
  });
  const track = trackById(next, clip.track);
  track.clips = track.clips.map((c) => (c.id === id ? patched : c));
  return next;
}

/**
 * Moves a layer one step up ("forward": drawn above its neighbour) or down ("backward") in its track. Only the layers:
 * images, shapes and text. A step past the end of the track changes nothing.
 */
export function reorderLayer(tracks, id, direction) {
  if (direction !== 'forward' && direction !== 'backward') throw new Error('Order must be "forward" or "backward".');
  const next = copyTracks(tracks);
  const clip = findClip(next, id);
  if (!clip) throw new Error('That layer no longer exists.');
  if (clip.kind === 'html' || clip.kind === 'audio') throw new Error('Only layers (images, shapes and text) have an order to change.');
  const track = trackById(next, clip.track);
  const i = track.clips.findIndex((c) => c.id === id);
  const j = direction === 'forward' ? i + 1 : i - 1;
  if (j < 0 || j >= track.clips.length) return next;
  [track.clips[i], track.clips[j]] = [track.clips[j], track.clips[i]];
  return next;
}


/** Puts layers into one group (they are then selected and moved as one). At least two layers are needed. */
export function groupClips(tracks, ids, groupId) {
  const next = copyTracks(tracks);
  const members = next.flatMap((t) => t.clips).filter((c) => ids.includes(c.id));
  if (members.length < 2) throw new Error('Select two or more layers to group them.');
  if (members.some((c) => !LAYER_KINDS.includes(c.kind))) throw new Error('Only images, shapes and text can be grouped.');
  const group = groupId || 'g_' + Math.random().toString(36).slice(2, 10);
  for (const t of next) for (const c of t.clips) if (ids.includes(c.id)) c.group = group;
  return next;
}

/** Sets the group of the given clips (null takes them out). Unlike groupClips, one clip may be given a group. */
export function tagClips(tracks, ids, group) {
  const next = copyTracks(tracks);
  for (const t of next) for (const c of t.clips) if (ids.includes(c.id)) c.group = group ?? null;
  return next;
}

/**
 * A selection with its groups completed: every layer and every canvas part that shares a group with a selected item is
 * selected too, so a group is always selected whole. `sel` is {layers: [clip ids], parts: [{index, key}]}; `partGroups` is
 * the list kept in the project (normalizeRenderOptions in shared/project-format.mjs).
 */
export function expandGroups(tracks, partGroups, sel) {
  const clips = tracks.flatMap((t) => t.clips);
  const groups = new Set();
  for (const id of sel.layers) {
    const c = clips.find((x) => x.id === id);
    if (c?.group) groups.add(c.group);
  }
  for (const p of sel.parts) for (const g of partGroups ?? []) if (g.index === p.index && g.key === p.key) groups.add(g.group);
  const layers = new Set(sel.layers);
  for (const c of clips) if (c.group && groups.has(c.group)) layers.add(c.id);
  const parts = [];
  const seen = new Set();
  const addPart = (p) => {
    const k = `${p.index}|${p.key}`;
    if (!seen.has(k)) {
      seen.add(k);
      parts.push({ index: p.index, key: p.key });
    }
  };
  sel.parts.forEach(addPart);
  for (const g of partGroups ?? []) if (groups.has(g.group)) addPart(g);
  return { layers: [...layers], parts };
}

/** Takes the layers of the groups that the given layers belong to out of their groups. */
export function ungroupClips(tracks, ids) {
  const next = copyTracks(tracks);
  const groups = new Set(next.flatMap((t) => t.clips).filter((c) => ids.includes(c.id) && c.group).map((c) => c.group));
  for (const t of next) for (const c of t.clips) if (groups.has(c.group)) c.group = null;
  return next;
}

/** Moves layers by an offset in frame pixels (x and y). Other clips and kinds are not changed. */
export function shiftLayers(tracks, ids, dx, dy) {
  const next = copyTracks(tracks);
  for (const t of next) {
    t.clips = t.clips.map((c) => (ids.includes(c.id) && LAYER_KINDS.includes(c.kind) ? normalizeClip({ ...c, x: c.x + dx, y: c.y + dy }) : c));
  }
  return next;
}

/** A rectangle moved and scaled from box `from` to box `to`: it keeps its place inside the box. */
export function scaledRect(r, from, to) {
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  return {
    x: Math.round(to.x + (r.x - from.x) * sx),
    y: Math.round(to.y + (r.y - from.y) * sy),
    w: Math.max(1, Math.round(r.w * sx)),
    h: Math.max(1, Math.round(r.h * sy)),
  };
}

/** Resizes layers from the selection box `from` to the box `to`. Text grows with its height. */
export function scaleLayers(tracks, ids, from, to) {
  const next = copyTracks(tracks);
  for (const t of next) {
    t.clips = t.clips.map((c) => {
      if (!ids.includes(c.id) || !LAYER_KINDS.includes(c.kind)) return c;
      const r = scaledRect(c, from, to);
      const patch = { x: r.x, y: r.y, w: r.w, h: r.h };
      if (c.kind === 'text' && from.h) patch.fontSize = Math.round(c.fontSize * (to.h / from.h));
      return normalizeClip({ ...c, ...patch });
    });
  }
  return next;
}

/** The ids of a layer's group (all of its members), or just its own id when it has no group. */
export function groupMembers(tracks, id) {
  const all = tracks.flatMap((t) => t.clips);
  const me = all.find((c) => c.id === id);
  if (!me) return [];
  if (!me.group) return [id];
  return all.filter((c) => c.group === me.group).map((c) => c.id);
}

/** The selection after a click on a layer: the layer's whole group. Shift-click adds the group, or removes it when it is in. */
export function pickIds(tracks, current, id, additive) {
  const members = groupMembers(tracks, id);
  if (!additive) return members;
  const rest = current.filter((c) => !members.includes(c));
  return members.every((m) => current.includes(m)) ? rest : [...rest, ...members];
}

/** Splits a clip in two at `time`. The second part gets `newId`. */
export function splitClip(tracks, id, { time, newId } = {}) {
  const next = copyTracks(tracks);
  const clip = requireClip(next, id);
  if (clip.kind === 'html') throw new Error('The HTML animation cannot be split.');
  const end = clip.start + clip.duration;
  if (time <= clip.start + MIN_CLIP_SEC || time >= end - MIN_CLIP_SEC) throw new Error('Move the playhead inside the clip to split it.');
  const first = normalizeClip({ ...clip, duration: time - clip.start });
  const second = normalizeClip({ ...clip, id: newId ?? newClipId(), start: time, duration: end - time, name: clip.name ? clip.name + ' (2)' : '' });
  const track = trackById(next, clip.track);
  track.clips = track.clips.flatMap((c) => (c.id === id ? [first, second] : [c]));
  return next;
}

export function deleteClip(tracks, id) {
  const next = copyTracks(tracks);
  requireClip(next, id);
  for (const t of next) t.clips = t.clips.filter((c) => c.id !== id);
  return next;
}

/** Changes properties of a clip. Kind, id, track and read-only narration clips cannot be changed here. */
export function updateClip(tracks, id, patch, total) {
  const next = copyTracks(tracks);
  const clip = requireClip(next, id);
  const { kind, id: _id, track: _track, ...rest } = patch;
  if (kind !== undefined && kind !== clip.kind) throw new Error('A clip cannot change its kind.');
  const merged = normalizeClip({ ...clip, ...rest });
  const clamped = normalizeClip({ ...merged, start: clampStart(merged.start, merged.duration, total) });
  const track = trackById(next, clip.track);
  track.clips = track.clips.map((c) => (c.id === id ? clamped : c));
  return next;
}

/**
 * Checks a timeline before it is saved. Returns a list of problems (empty when it is valid).
 * @param {Array<{id: string, clips: Array<any>}>} tracks
 */
export function validateTimeline(tracks) {
  const problems = [];
  const ids = new Set();
  let html = 0;
  for (const track of tracks) {
    if (!TRACK_KINDS[track.id]) problems.push(`Unknown track "${track.id}".`);
    for (const c of track.clips) {
      if (ids.has(c.id)) problems.push(`Two clips share the id ${c.id}.`);
      ids.add(c.id);
      if (c.track !== track.id) problems.push(`Clip ${c.id} is listed on the wrong track.`);
      if (!CLIP_KINDS.includes(c.kind)) problems.push(`Clip ${c.id} has an unknown kind.`);
      else if (!(TRACK_KINDS[track.id] ?? []).includes(c.kind)) problems.push(`Clip ${c.id} (${c.kind}) is on the ${track.id} track.`);
      if (!(c.start >= 0) || !(c.duration >= MIN_CLIP_SEC)) problems.push(`Clip ${c.id} has an invalid time.`);
      if (c.kind === 'html') html++;
    }
  }
  if (html > 1) problems.push('A project has one HTML animation.');
  return problems;
}

/** How opaque a clip is at time t: its own opacity times its fade-in and fade-out. */
export function fadeFactor(c, t) {
  let f = 1;
  if (c.fadeIn > 0) f = Math.min(f, (t - c.start) / c.fadeIn);
  if (c.fadeOut > 0) f = Math.min(f, (c.start + c.duration - t) / c.fadeOut);
  return Math.min(1, Math.max(0, f));
}

/**
 * Everything the render page needs at time t. The base animation is the HTML clip (if any); its animation
 * time is its offset plus the time since its start. Layers come in track order, then clip order.
 * @returns {{base: {visible: boolean, animSec: number, assetId: string|null}, layers: Array<object>}}
 */
export function layerStates(tracks, t) {
  const out = { base: { visible: false, animSec: 0, assetId: null }, layers: [] };
  const html = tracks.flatMap((tr) => tr.clips).find((c) => c.kind === 'html') ?? null;
  if (html) {
    const visible = t >= html.start && t < html.start + html.duration;
    out.base = { visible, animSec: html.offset + Math.max(0, t - html.start), assetId: html.assetId };
  }
  let z = 0;
  for (const tr of tracks) {
    for (const c of tr.clips) {
      if (c.kind === 'html' || c.kind === 'audio') continue;
      const visible = t >= c.start && t < c.start + c.duration;
      out.layers.push({
        id: c.id,
        kind: c.kind,
        track: tr.id,
        z: z++,
        behind: c.behind,
        visible,
        opacity: Math.round(c.opacity * fadeFactor(c, t) * 1000) / 1000,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        rotation: c.rotation,
        assetId: c.assetId ?? null,
        text: c.text,
        fontSize: c.fontSize,
        fontWeight: c.fontWeight,
        color: c.color,
        align: c.align,
        shape: c.shape,
        fill: c.fill,
        stroke: c.stroke,
        strokeWidth: c.strokeWidth,
        group: c.group ?? null,
        html: c.html,
      });
    }
  }
  return out;
}

/** Narration and music clips with their volume and fades, for the audio mix (Stage 5). */
export function audioClips(tracks) {
  return tracks
    .filter((tr) => tr.id === 'narration' || tr.id === 'music')
    .flatMap((tr) => tr.clips.filter((c) => c.kind === 'audio'));
}
