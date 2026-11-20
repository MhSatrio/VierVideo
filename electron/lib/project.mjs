// A VierVideo project is a folder:
//   <folder>/project.vvproj.json   the project document (settings, folders, assets, timeline)
//   <folder>/assets/               private copies of imported files, named by checksum
// Originals are never modified or moved. Every change is written to disk immediately (atomic write).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ASSET_DIR, DEFAULT_SETTINGS, PROJECT_FILE, TEXT_KINDS, MAX_IMPORT_BYTES, MAX_TEXT_PREVIEW_BYTES,
  TRACKS, cleanName, kindForFileName, newId, normalizeNarration, normalizeRenderOptions, normalizeSettings, validateProjectDoc,
} from '../../shared/project-format.mjs';
import { exists, resolveInside, safeName, sha256File, writeJsonAtomic } from './fsx.mjs';
import { layoutStarts, segmentSignature } from '../../shared/narration.mjs';
import { isReadOnly, makeClip, normalizeTracks, trackById, validateTimeline } from '../../shared/timeline.mjs';

export class ProjectError extends Error {}

const nowIso = () => new Date().toISOString();
const MAX_CODE_BYTES = 5 * 1024 * 1024;

export class Project {
  #dir;
  #doc;
  #queue = Promise.resolve();
  savedAt = null;

  constructor(dir, doc) {
    this.#dir = dir;
    this.#doc = doc;
  }

  get dir() {
    return this.#dir;
  }

  get name() {
    return this.#doc.name;
  }

  /** Serialise a change: `fn(draft)` edits a copy; the copy is validated and written before it becomes current. */
  mutate(fn) {
    const run = async () => {
      const draft = structuredClone(this.#doc);
      const result = await fn(draft);
      draft.updatedAt = nowIso();
      const valid = validateProjectDoc(draft);
      await writeJsonAtomic(path.join(this.#dir, PROJECT_FILE), valid);
      this.#doc = valid;
      this.savedAt = valid.updatedAt;
      return result;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  /** Current document plus which assets' files are missing on disk. */
  async state() {
    const missing = [];
    for (const a of this.#doc.assets) {
      if (!(await exists(resolveInside(this.#dir, a.file)))) missing.push(a.id);
    }
    return { dir: this.#dir, doc: structuredClone(this.#doc), missing, savedAt: this.savedAt };
  }

  /** Absolute file path of an asset in this project, or null. Only ids from the document are honoured. */
  assetFile(id) {
    const a = this.#doc.assets.find((x) => x.id === id);
    return a ? resolveInside(this.#dir, a.file) : null;
  }

  async save() {
    return this.mutate(async () => {});
  }

  async updateSettings(patch) {
    return this.mutate(async (d) => {
      d.settings = normalizeSettings({ ...d.settings, ...patch });
      // The timeline stores the same duration, so the file has one source of truth for it.
      d.timeline = { ...d.timeline, durationSec: d.settings.durationSec };
    });
  }

  async rename(name) {
    const clean = cleanName(name);
    return this.mutate(async (d) => {
      d.name = clean;
    });
  }

  async createFolder(name) {
    const clean = cleanName(name, 60);
    return this.mutate(async (d) => {
      if (d.folders.some((f) => f.name.toLowerCase() === clean.toLowerCase())) {
        throw new ProjectError(`A folder named "${clean}" already exists.`);
      }
      d.folders.push({ id: newId('f'), name: clean });
    });
  }

  async renameFolder(id, name) {
    const clean = cleanName(name, 60);
    return this.mutate(async (d) => {
      const f = d.folders.find((x) => x.id === id);
      if (!f) throw new ProjectError('That folder no longer exists.');
      if (d.folders.some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) {
        throw new ProjectError(`A folder named "${clean}" already exists.`);
      }
      f.name = clean;
    });
  }

  /** Deleting a folder keeps its assets: they move to "Unfiled". */
  async deleteFolder(id) {
    return this.mutate(async (d) => {
      d.folders = d.folders.filter((f) => f.id !== id);
      for (const a of d.assets) if (a.folderId === id) a.folderId = null;
    });
  }

  async moveAsset(id, folderId) {
    return this.mutate(async (d) => {
      const a = d.assets.find((x) => x.id === id);
      if (!a) throw new ProjectError('That asset is no longer in the project.');
      if (folderId != null && !d.folders.some((f) => f.id === folderId)) throw new ProjectError('That folder no longer exists.');
      a.folderId = folderId ?? null;
    });
  }

  async renameAsset(id, name) {
    const clean = cleanName(name);
    return this.mutate(async (d) => {
      const a = d.assets.find((x) => x.id === id);
      if (!a) throw new ProjectError('That asset is no longer in the project.');
      a.name = clean;
    });
  }

  /** Removes the asset from the project and deletes its private copy. The original file is untouched. */
  async removeAsset(id) {
    let removedFile = null;
    const state = await this.mutate(async (d) => {
      const a = d.assets.find((x) => x.id === id);
      if (!a) throw new ProjectError('That asset is no longer in the project.');
      removedFile = a.file;
      d.assets = d.assets.filter((x) => x.id !== id);
    });
    if (removedFile && !this.#doc.assets.some((a) => a.file === removedFile)) {
      await fs.rm(resolveInside(this.#dir, removedFile), { force: true });
    }
    return state;
  }

  /**
   * Saves the timeline edited in the renderer. Narration clips are not taken from the renderer: they follow the
   * segments. Every clip must refer to a file of the right kind in the library.
   */
  async setTimeline(tracks) {
    return this.mutate(async (d) => {
      const incoming = normalizeTracks(tracks);
      const problems = validateTimeline(incoming);
      const assetOf = (id) => d.assets.find((a) => a.id === id) ?? null;
      for (const tr of incoming) {
        for (const c of tr.clips) {
          if (c.kind === 'html' && assetOf(c.assetId)?.kind !== 'html') problems.push('The HTML animation is not in the project.');
          if (c.kind === 'image' && !['image', 'svg'].includes(assetOf(c.assetId)?.kind)) {
            problems.push(`The layer "${c.name || 'image'}" needs an image or SVG from the library.`);
          }
          if (c.kind === 'audio' && !isReadOnly(c) && assetOf(c.assetId)?.kind !== 'audio') {
            problems.push('A music clip needs an audio file from the library.');
          }
        }
      }
      if (problems.length) throw new ProjectError(problems[0]);
      for (const id of ['html', 'visual', 'text', 'narration', 'music']) {
        if (!trackById(incoming, id)) incoming.push({ id, name: id, clips: [] });
      }
      // A narration clip moved on the timeline moves its segment: the segment's start is the time it plays at.
      for (const c of trackById(incoming, 'narration').clips) {
        if (!c.segmentId) continue;
        const seg = d.narration?.segments.find((s) => s.id === c.segmentId);
        if (seg && Number.isFinite(c.start)) seg.start = Math.round(Math.max(0, c.start) * 100) / 100;
      }
      syncNarrationClips(d);
      trackById(incoming, 'narration').clips = trackById(d.timeline.tracks, 'narration')?.clips ?? [];
      d.timeline = { ...d.timeline, durationSec: d.settings.durationSec, tracks: incoming };
    });
  }

  /** Replaces the narration: the script it comes from, its voice and speed, and its segments (none generated yet). */
  async setNarration({ sourceAssetId, voice, speed, segments }) {
    return this.mutate(async (d) => {
      if (!sourceAssetId || !d.assets.some((a) => a.id === sourceAssetId && a.kind === 'script')) {
        throw new ProjectError('That script is no longer in the project.');
      }
      if (!Array.isArray(segments) || segments.length === 0) throw new ProjectError('The script has no segments.');
      if (segments.length > 500) throw new ProjectError('A narration can have at most 500 segments.');
      d.narration = normalizeNarration({
        sourceAssetId,
        voice,
        speed,
        segments: segments.map((x) => ({ ...x, status: 'pending', file: null, durationSec: null, signature: null, error: null })),
      });
      syncNarrationClips(d);
    });
  }

  /** Voice or speed changed: every segment whose audio no longer matches is marked stale. */
  async setNarrationSettings({ voice, speed }) {
    return this.mutate(async (d) => {
      const n = requireNarration(d);
      const next = normalizeNarration({ ...n, voice: voice ?? n.voice, speed: speed ?? n.speed });
      next.segments = next.segments.map((seg) => refreshSegmentStatus(seg, next));
      d.narration = next;
      syncNarrationClips(d);
    });
  }

  async editSegment(id, text) {
    return this.mutate(async (d) => {
      const n = requireNarration(d);
      const seg = n.segments.find((x) => x.id === id);
      if (!seg) throw new ProjectError('That segment no longer exists.');
      const clean = String(text ?? '').trim();
      if (!clean) throw new ProjectError('The text is empty.');
      seg.text = clean.slice(0, 2000);
      refreshSegmentStatus(seg, n);
      syncNarrationClips(d);
    });
  }

  async setSegmentAudio(id, { file, durationSec, signature }) {
    return this.mutate(async (d) => {
      const n = requireNarration(d);
      const seg = n.segments.find((x) => x.id === id);
      if (!seg) throw new ProjectError('That segment no longer exists.');
      Object.assign(seg, { file, durationSec, signature, status: 'ok', error: null });
      syncNarrationClips(d);
    });
  }

  async setSegmentError(id, message) {
    return this.mutate(async (d) => {
      const n = requireNarration(d);
      const seg = n.segments.find((x) => x.id === id);
      if (!seg) return;
      seg.status = 'error';
      seg.error = String(message).slice(0, 500);
      syncNarrationClips(d);
    });
  }

  async clearNarration() {
    return this.mutate(async (d) => {
      d.narration = null;
      syncNarrationClips(d);
    });
  }

  /** Absolute path for a narration audio file (audio/...); creates the folder. */
  async audioTarget(rel) {
    const target = resolveInside(this.#dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    return target;
  }

  /** Render options of an HTML animation (mode and page elements to hide). */
  async setRenderOptions(id, input) {
    return this.mutate(async (d) => {
      const a = d.assets.find((x) => x.id === id);
      if (!a) throw new ProjectError('That asset is no longer in the project.');
      if (a.kind !== 'html') throw new ProjectError('Only HTML animations have render options.');
      a.render = normalizeRenderOptions({ ...(a.render ?? {}), ...(input ?? {}) });
    });
  }

  /** Records a finished export. The file itself lives in renders/ inside the project. */
  async addRender(record) {
    return this.mutate(async (d) => {
      d.renders = [...(d.renders ?? []), record];
    });
  }

  /** Absolute path of a file under renders/ in this project, or null. Used for "show in folder". */
  fileInside(rel) {
    if (typeof rel !== 'string' || !(rel.startsWith('renders/') || rel.startsWith('audio/')) || rel.includes('..')) return null;
    try {
      return resolveInside(this.#dir, rel);
    } catch {
      return null;
    }
  }

  /** Absolute path for a new export file; creates renders/ if needed. */
  async renderTarget(fileName) {
    const dirPath = resolveInside(this.#dir, 'renders');
    await fs.mkdir(dirPath, { recursive: true });
    return resolveInside(this.#dir, path.join('renders', fileName));
  }

  /**
   * Imports files into the project. Identical content (same SHA-256) is not copied twice.
   * @returns {Promise<{results: Array<{source: string, status: 'imported'|'duplicate'|'skipped', name: string, reason?: string}>}>}
   */
  async importFiles(filePaths, folderId = null) {
    // Hash and inspect outside the write queue; the queue only commits the result.
    const prepared = [];
    for (const src of filePaths) {
      const name = path.basename(src);
      try {
        const st = await fs.stat(src);
        if (!st.isFile()) throw new ProjectError('not a file');
        const meta = kindForFileName(name);
        if (!meta) throw new ProjectError('unsupported file type');
        if (st.size > MAX_IMPORT_BYTES) throw new ProjectError('file is larger than 500 MB');
        if (st.size === 0) throw new ProjectError('file is empty');
        prepared.push({ src, name, meta, bytes: st.size, sha256: await sha256File(src) });
      } catch (err) {
        prepared.push({ src, name, error: err.message });
      }
    }

    return this.mutate(async (d) => {
      if (folderId != null && !d.folders.some((f) => f.id === folderId)) folderId = null;
      const results = [];
      for (const p of prepared) {
        if (p.error) {
          results.push({ source: p.src, name: p.name, status: 'skipped', reason: p.error });
          continue;
        }
        const dup = d.assets.find((a) => a.sha256 === p.sha256);
        if (dup) {
          results.push({ source: p.src, name: p.name, status: 'duplicate', reason: `already in the project as "${dup.name}"` });
          continue;
        }
        const file = `${ASSET_DIR}/${p.sha256.slice(0, 16)}-${safeName(path.parse(p.name).name)}${p.meta.ext}`;
        const target = resolveInside(this.#dir, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(p.src, target);
        d.assets.push({
          id: newId('a'),
          name: p.name,
          originalName: p.name,
          kind: p.meta.kind,
          ext: p.meta.ext,
          mime: p.meta.mime,
          bytes: p.bytes,
          sha256: p.sha256,
          file,
          folderId,
          addedAt: nowIso(),
        });
        results.push({ source: p.src, name: p.name, status: 'imported' });
      }
      return { results };
    });
  }

  /** Text content of a script asset (for preview). Capped in size. */
  async readText(id) {
    const a = this.#doc.assets.find((x) => x.id === id);
    if (!a) throw new ProjectError('That asset is no longer in the project.');
    if (!TEXT_KINDS.includes(a.kind)) throw new ProjectError('This asset is not a text file.');
    const file = resolveInside(this.#dir, a.file);
    const st = await fs.stat(file);
    if (st.size > MAX_TEXT_PREVIEW_BYTES) throw new ProjectError('Text file is too large to preview (over 5 MB).');
    return fs.readFile(file, 'utf8');
  }

  /**
   * Replaces the code of an HTML animation. The change is made to the copy inside the project; the original file
   * you imported is never touched. The first edit keeps the copy as it was (restoreOriginal can bring it back).
   */
  async writeText(id, text) {
    return this.mutate(async (d) => {
      const a = d.assets.find((x) => x.id === id);
      if (!a) throw new ProjectError('That asset is no longer in the project.');
      if (a.kind !== 'html') throw new ProjectError('Only HTML animations can be edited as code.');
      const body = String(text ?? '');
      if (!body.trim()) throw new ProjectError('The code is empty, so nothing was saved.');
      const bytes = Buffer.from(body, 'utf8');
      if (bytes.length > MAX_CODE_BYTES) throw new ProjectError('The code is larger than 5 MB.');
      const target = resolveInside(this.#dir, a.file);
      if (!(await exists(originalOf(target)))) await fs.copyFile(target, originalOf(target));
      await fs.writeFile(target + '.tmp', bytes);
      await fs.rename(target + '.tmp', target);
      a.sha256 = createHash('sha256').update(bytes).digest('hex');
      a.bytes = bytes.length;
      a.edited = true;
      a.editedAt = nowIso();
      return { asset: a.id };
    });
  }

  /** Puts back the HTML animation as it was when it was imported. */
  async restoreOriginal(id) {
    return this.mutate(async (d) => {
      const a = d.assets.find((x) => x.id === id);
      if (!a) throw new ProjectError('That asset is no longer in the project.');
      if (!a.edited) throw new ProjectError('This animation has not been edited.');
      const target = resolveInside(this.#dir, a.file);
      if (!(await exists(originalOf(target)))) throw new ProjectError('The original copy is missing from the project.');
      await fs.copyFile(originalOf(target), target);
      const bytes = await fs.readFile(target);
      a.sha256 = createHash('sha256').update(bytes).digest('hex');
      a.bytes = bytes.length;
      a.edited = false;
      delete a.editedAt;
      return { asset: a.id };
    });
  }
}

/** The copy of an animation as it was imported, kept next to the working copy. */
function originalOf(file) {
  return file + '.original';
}

function requireNarration(d) {
  if (!d.narration) throw new ProjectError('Create a narration from a script first.');
  return d.narration;
}

/** Sets a segment to ok / stale / pending according to whether its audio matches the current text, voice and speed. */
function refreshSegmentStatus(seg, n) {
  const sig = segmentSignature({ text: seg.text, voice: n.voice, speed: n.speed });
  if (seg.file && seg.signature === sig) seg.status = 'ok';
  else if (seg.file) seg.status = 'stale';
  else seg.status = 'pending';
  return seg;
}

/** The narration track on the timeline holds one clip per ready segment, placed at its start time. */
function syncNarrationClips(d) {
  const track = d.timeline.tracks.find((t) => t.id === 'narration');
  if (!track) return;
  const segs = d.narration ? d.narration.segments : [];
  const durations = segs.map((x) => (x.status === 'ok' && x.durationSec ? x.durationSec : 0));
  const starts = layoutStarts(segs, durations);
  track.clips = segs
    .map((x, i) => ({ x, start: starts[i] }))
    .filter(({ x }) => x.status === 'ok')
    .map(({ x, start }) => makeClip('audio', 'narration', start, x.durationSec, { id: 'clip_' + x.id, segmentId: x.id, name: x.text.slice(0, 40) }));
}

/** Create a new project in <parentDir>/<name>. The folder must not exist or must be empty. */
export async function createProject({ parentDir, name, settings }) {
  const clean = cleanName(name);
  const dir = path.join(parentDir, safeName(clean, 'VierVideo project'));
  const existing = await fs.readdir(dir).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (existing && existing.length) {
    throw new ProjectError(`The folder "${path.basename(dir)}" already exists and is not empty. Choose another name or folder.`);
  }
  await fs.mkdir(path.join(dir, ASSET_DIR), { recursive: true });
  const now = nowIso();
  const s = normalizeSettings({ ...DEFAULT_SETTINGS, ...(settings ?? {}) });
  const doc = validateProjectDoc({
    format: 'viervideo-project',
    version: 1,
    id: newId('p'),
    name: clean,
    createdAt: now,
    updatedAt: now,
    settings: s,
    folders: [],
    assets: [],
    timeline: {
      durationSec: s.durationSec,
      tracks: TRACKS.map((t) => ({ id: t.id, name: t.name, clips: [] })),
    },
  });
  await writeJsonAtomic(path.join(dir, PROJECT_FILE), doc);
  const proj = new Project(dir, doc);
  proj.savedAt = now;
  return proj;
}

/** Open an existing project folder. Throws a readable error for anything that is not a valid project. */
export async function openProject(dir) {
  const file = path.join(dir, PROJECT_FILE);
  if (!(await exists(file))) throw new ProjectError('No VierVideo project found in that folder.');
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new ProjectError('The project file is damaged. A backup may exist next to it (project.vvproj.json.bak).');
  }
  const doc = validateProjectDoc(parsed);
  const proj = new Project(dir, doc);
  proj.savedAt = doc.updatedAt;
  return proj;
}
