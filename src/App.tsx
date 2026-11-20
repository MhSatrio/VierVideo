import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppInfo, ElementInfo, FfmpegInfo, ImportResult, NarrationProgress, PartKey, PartRecord, ProjectAsset, ProjectState, RecentEntry, RenderOptions, TimelineTrack, TtsStatus, Voice } from './model/types';
import type { Box, Items } from './panels/CompositionPreview';
import { StartScreen } from './panels/StartScreen';
import { ProjectBar } from './panels/ProjectBar';
import { AssetLibrary } from './panels/AssetLibrary';
import { PreviewPanel } from './panels/PreviewPanel';
import { InspectorPanel, type ExportState } from './panels/InspectorPanel';
import type { NarrationActions } from './panels/NarrationPanel';
import { TimelinePanel, type AddKind } from './panels/TimelinePanel';
import { CompositionPreview } from './panels/CompositionPreview';
import { ClipInspector } from './panels/ClipInspector';
import { addClip, deleteClip, expandGroups, findClip, makeClip, moveClip, reorderLayer, scaleLayers, shiftLayers, splitClip, tagClips, updateClip } from '../shared/timeline.mjs';
import { composePartOffsets } from '../shared/project-format.mjs';
import { NewProjectDialog } from './panels/NewProjectDialog';
import { AboutDialog } from './panels/AboutDialog';
import { StatusLine, type Status } from './panels/StatusLine';
import { CodeEditor } from './panels/CodeEditor';
import { Studio, coversFrame } from './panels/Studio';
import { MasterPromptDialog } from './panels/MasterPromptDialog';
import { ContextMenu } from './panels/ContextMenu';
import './panels/features.css';

type DialogName = 'new' | 'about' | 'master' | null;

function summarize(results: ImportResult[]): Status {
  const imported = results.filter((r) => r.status === 'imported').length;
  const dupes = results.filter((r) => r.status === 'duplicate').length;
  const skipped = results.filter((r) => r.status === 'skipped');
  const parts = [imported > 0 ? `Imported ${imported} file${imported === 1 ? '' : 's'}` : 'Nothing was imported'];
  if (dupes) parts.push(`${dupes} already in the project`);
  if (skipped.length) {
    parts.push(`${skipped.length} skipped (${skipped.slice(0, 2).map((s) => `${s.name}: ${s.reason}`).join('; ')})`);
  }
  return { kind: imported === 0 && skipped.length > 0 ? 'error' : 'info', text: parts.join(' · ') + '.' };
}

/** The HTML animation on the timeline (the base of the picture), or null. */
function htmlAssetOf(project: ProjectState | null): ProjectAsset | null {
  if (!project) return null;
  const clip = project.doc.timeline.tracks.flatMap((t) => t.clips).find((c) => c.kind === 'html');
  return clip ? project.doc.assets.find((a) => a.id === clip.assetId) ?? null : null;
}

/** The render options of the HTML animation on the timeline (its moved parts and element offsets), or undefined. */
function htmlRenderOf(project: ProjectState | null): ProjectAsset['render'] {
  return htmlAssetOf(project)?.render;
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [project, setProject] = useState<ProjectState | null>(null);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<string>('all');
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [ready, setReady] = useState(false);
  const [exporting, setExporting] = useState<ExportState | null>(null);
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null | undefined>(undefined);
  const [playhead, setPlayhead] = useState(0);
  // The selected layers and clips (ids, in the order they were picked). The last one is the one the inspector shows.
  const [selection, setSelection] = useState<string[]>([]);
  // The canvas parts selected in the studio (their number and key; the stretch of the video is the playhead's).
  const [partSel, setPartSel] = useState<PartKey[]>([]);
  const selectedClipId = selection.length > 0 ? selection[selection.length - 1] : null;
  const setSelectedClipId = (id: string | null) => setSelection(id ? [id] : []);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [speedRange, setSpeedRange] = useState<[number, number]>([0.7, 1.3]);
  const [tts, setTts] = useState<TtsStatus | null | undefined>(undefined);
  const [narrProgress, setNarrProgress] = useState<NarrationProgress | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [inspected, setInspected] = useState<ElementInfo | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  // The project whose narration is made once the engine is ready (set when the example is created).
  const [narrateId, setNarrateId] = useState<string | null>(null);
  // The paint calls of the animation at the playhead, for the studio's list of parts.
  const [parts, setParts] = useState<PartRecord[]>([]);

  const fail = useCallback((err: unknown) => {
    setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
  }, []);
  const notify = useCallback((text: string) => setStatus({ kind: 'info', text }), []);

  /** Runs an IPC call, shows its error in the status line, and returns undefined on failure. */
  const run = useCallback(async <T,>(fn: () => Promise<T>, label?: string): Promise<T | undefined> => {
    if (label) setBusy(label);
    try {
      return await fn();
    } catch (err) {
      fail(err);
      return undefined;
    } finally {
      if (label) setBusy(null);
    }
  }, [fail]);

  const applyState = useCallback((s: ProjectState | null) => {
    setProject(s);
    setSelected((prev) => (s && prev && s.doc.assets.some((a) => a.id === prev) ? prev : null));
    if (!s) setFolderFilter('all');
    else if (folderFilter !== 'all' && folderFilter !== 'unfiled' && !s.doc.folders.some((f) => f.id === folderFilter)) {
      setFolderFilter('all');
    }
  }, [folderFilter]);

  const refreshRecent = useCallback(async () => {
    const list = await run(() => window.vv.recent());
    if (list) setRecent(list);
  }, [run]);

  // Initial load: app info, recent projects, and the project that was open before a reload.
  useEffect(() => {
    (async () => {
      const [i, r, s] = await Promise.all([
        window.vv.info().catch(() => null),
        window.vv.recent().catch(() => [] as RecentEntry[]),
        window.vv.state().catch(() => null),
      ]);
      setInfo(i);
      setRecent(r);
      setProject(s);
      setReady(true);
      if (!s) {
        // First start: the example project opens by itself (the main process decides, once).
        const started = await window.vv.startExample().catch(() => null);
        if (started) {
          setProject(started.state);
          setNarrateId(started.created ? started.state.doc.id : null);
          setStatus({ kind: 'info', text: 'The example project is open. Play it, right-click the preview to edit an element, or start a new project.' });
        }
      }
      window.vv.ffmpegStatus().then(setFfmpeg).catch(() => setFfmpeg(null));
      window.vv.ttsVoices().then((v) => {
        setVoices(v.voices);
        setSpeedRange([v.speedMin, v.speedMax]);
      }).catch(() => undefined);
      window.vv.ttsStatus().then(setTts).catch(() => setTts(null));
    })();
  }, []);

  useEffect(
    () =>
      window.vv.onRenderProgress((p) =>
        setExporting((prev) => (prev ? { ...prev, id: p.id, frame: p.frame, total: p.total, percent: p.percent } : prev)),
      ),
    [],
  );

  useEffect(() => window.vv.onNarrationProgress((p) => setNarrProgress(p)), []);
  useEffect(() => window.vv.onFullScreen((on) => setFullScreen(on)), []);

  const startExport = async (assetId: string) => {
    setExporting({ assetId, id: null, frame: 0, total: 0, percent: 0 });
    const r = await run(() => window.vv.exportVideo({ assetId }));
    setExporting(null);
    if (r) {
      applyState(r.state);
      const file = r.render.file.replace(/^renders\//, '');
      setStatus({ kind: 'info', text: `Exported ${file} (${r.render.frames} frames).${r.warnings.length ? ' ' + r.warnings.join(' ') : ''}` });
    }
  };

  const chooseFfmpeg = async () => {
    const info = await run(() => window.vv.chooseFfmpeg());
    if (info) {
      setFfmpeg(info);
      notify(`FFmpeg set to ${info.path}.`);
    }
  };

  const openDir = async (dir: string) => {
    const s = await run(() => window.vv.openProject(dir), 'Opening project…');
    if (s) {
      setSelected(null);
      setFolderFilter('all');
      setProject(s);
      notify(`Opened "${s.doc.name}".`);
    }
    refreshRecent();
  };

  const openFromDialog = async () => {
    const dir = await run(() => window.vv.pickFolder('Open a VierVideo project folder'));
    if (dir) await openDir(dir);
  };

  const onProjectCreated = (s: ProjectState) => {
    setSelected(null);
    setFolderFilter('all');
    setProject(s);
    setDialog(null);
    notify(`Created "${s.doc.name}". Changes are saved automatically.`);
    refreshRecent();
  };

  const importPaths = async (paths: string[]) => {
    if (!project || paths.length === 0) return;
    const target = folderFilter !== 'all' && folderFilter !== 'unfiled' ? folderFilter : null;
    const r = await run(() => window.vv.importFiles(paths, target), 'Importing…');
    if (r) {
      setProject(r.state);
      setStatus(summarize(r.results));
    }
  };

  const importFromDialog = async () => {
    const files = await run(() => window.vv.pickFiles());
    if (files) await importPaths(files);
  };

  const saveNow = async () => {
    const s = await run(() => window.vv.save());
    if (s) {
      setProject(s);
      notify('Saved.');
    }
  };

  const closeProject = async () => {
    await run(() => window.vv.closeProject());
    setProject(null);
    setSelected(null);
    setFolderFilter('all');
    refreshRecent();
  };

  const forgetRecent = async (dir: string) => {
    const list = await run(() => window.vv.forgetRecent(dir));
    if (list) setRecent(list);
  };

  /** Each project mutation returns the new state, which replaces the one on screen. */
  const mutate = async (fn: () => Promise<ProjectState>) => {
    const s = await run(fn);
    if (s) applyState(s);
    return s;
  };

  // Menu actions from the native menu (File / Help).
  const menuHandlers = useRef<Record<string, () => void>>({});
  menuHandlers.current = {
    new: () => setDialog('new'),
    open: () => void openFromDialog(),
    import: () => void (project && importFromDialog()),
    save: () => void (project && saveNow()),
    reveal: () => void (project && run(() => window.vv.revealProject())),
    close: () => void (project && closeProject()),
    about: () => setDialog('about'),
    master: () => setDialog('master'),
  };
  useEffect(() => window.vv.onMenu((action) => menuHandlers.current[action]?.()), []);

  const timelineExporting = exporting?.assetId === '__timeline__';

  // ---------- timeline (Stage 4) ----------

  /** Saves a timeline change. The shared model checks the change first; the main process checks it again. */
  const applyTimeline = (change: (tracks: TimelineTrack[]) => TimelineTrack[]) => {
    if (!project) return Promise.resolve(undefined);
    let next: TimelineTrack[];
    try {
      next = change(project.doc.timeline.tracks);
    } catch (err) {
      fail(err);
      return Promise.resolve(undefined);
    }
    return mutate(() => window.vv.saveTimeline(next));
  };

  const selectClip = (id: string | null) => {
    setSelectedClipId(id);
    if (id) {
      setSelected(null);
      setCodeOpen(false); // a clip is shown in the inspector, not the code
    }
  };

  /**
   * Selects layers (clip ids) and canvas parts (number and key): the studio's selection, a marquee, or a group. Empty
   * lists clear the selection.
   */
  const selectItems = (layers: string[], parts: PartKey[]) => {
    setSelection(layers);
    setPartSel(parts);
    if (layers.length > 0 || parts.length > 0) {
      setSelected(null);
      setCodeOpen(false);
    }
  };

  /** A click on a layer in the studio's list: the layer with its group; shift-click adds the group, or removes it. */
  const pickLayer = (id: string, additive: boolean) => {
    const group = expandGroups(project?.doc.timeline.tracks ?? [], htmlRenderOf(project)?.partGroups ?? [], { layers: [id], parts: [] });
    if (!additive) return selectItems(group.layers, group.parts);
    const isIn = group.layers.every((x) => selection.includes(x)) && group.parts.every((p) => partSel.some((k) => k.index === p.index && k.key === p.key));
    const layers = isIn ? selection.filter((x) => !group.layers.includes(x)) : [...selection.filter((x) => !group.layers.includes(x)), ...group.layers];
    const parts = isIn
      ? partSel.filter((k) => !group.parts.some((p) => p.index === k.index && p.key === k.key))
      : [...partSel.filter((k) => !group.parts.some((p) => p.index === k.index && p.key === k.key)), ...group.parts];
    selectItems(layers, parts);
  };

  const addAtPlayhead = (kind: AddKind) => {
    if (!project) return;
    const total = project.doc.settings.durationSec;
    const at = playhead;
    const asset = selected ? project.doc.assets.find((a) => a.id === selected) ?? null : null;
    let clip: any = null;
    try {
      if (kind === 'text') clip = makeClip('text', 'text', at, 3, { text: 'Your text' });
      else if (kind === 'rect') clip = makeClip('shape', 'visual', at, 3, { shape: 'rect' });
      else if (kind === 'ellipse') clip = makeClip('shape', 'visual', at, 3, { shape: 'ellipse', x: 290, y: 800, w: 500, h: 500 });
      else if (kind === 'line') clip = makeClip('shape', 'visual', at, 3, { shape: 'line', x: 240, y: 960, w: 600, h: 20, stroke: '#231f20', strokeWidth: 6 });
      else if (kind === 'arrow') clip = makeClip('shape', 'visual', at, 3, { shape: 'arrow', x: 240, y: 960, w: 600, h: 60, stroke: '#4570b6', strokeWidth: 8 });
      else if (kind === 'image') {
        if (!asset || (asset.kind !== 'image' && asset.kind !== 'svg')) throw new Error('Select an image or SVG in the library first.');
        clip = makeClip('image', 'visual', at, 3, { assetId: asset.id, name: asset.name, x: 240, y: 600, w: 600, h: 600 });
      } else if (kind === 'music') {
        if (!asset || asset.kind !== 'audio') throw new Error('Select an audio file in the library first.');
        clip = makeClip('audio', 'music', at, 10, { assetId: asset.id, name: asset.name });
      } else if (kind === 'html') {
        if (!asset || asset.kind !== 'html') throw new Error('Select an HTML animation in the library first.');
        clip = makeClip('html', 'html', 0, total, { assetId: asset.id, name: asset.name });
      }
    } catch (err) {
      fail(err);
      return;
    }
    const added = clip;
    void applyTimeline((tracks) => addClip(tracks, added, total)).then((s) => {
      if (s) setSelectedClipId(added.id);
    });
  };

  const splitSelected = () => {
    if (!selectedClipId) return fail(new Error('Select a clip to split.'));
    const id = selectedClipId;
    void applyTimeline((t) => splitClip(t, id, { time: playhead }));
  };

  const deleteSelected = () => {
    if (selection.length === 0) return;
    const ids = selection;
    void applyTimeline((t) => ids.reduce((acc, id) => deleteClip(acc, id), t)).then((s) => {
      if (s) setSelection([]);
    });
  };

  /** Adds an HTML element as a layer at the playhead (the studio's element dialog). The animation is not changed. */
  const importSnippet = (html: string, name: string) => {
    if (!project) return;
    const total = project.doc.settings.durationSec;
    let clip;
    try {
      clip = makeClip('snippet', 'visual', playhead, 3, { html, name });
    } catch (err) {
      fail(err);
      return;
    }
    const added = clip;
    void applyTimeline((tracks) => addClip(tracks, added, total)).then((s) => {
      if (s) setSelection([added.id]);
    });
  };

  /**
   * Groups the selected layers and canvas parts: they are then selected, moved and resized together. Two or more items are
   * needed. A part's stretch of the video is the playhead's, so the group keeps the part as it is at this time.
   */
  const groupSelection = async () => {
    const layerIds = selection;
    const partKeys = partSel;
    if (layerIds.length + partKeys.length < 2) {
      return fail(new Error('Select two or more layers or canvas parts to group them (drag on empty space, or Shift-click).'));
    }
    const gid = 'g_' + Math.random().toString(36).slice(2, 10);
    if (layerIds.length > 0) await applyTimeline((t) => tagClips(t, layerIds, gid));
    const asset = htmlAssetOf(project);
    if (partKeys.length > 0 && asset) {
      const existing = asset.render?.partGroups ?? [];
      const members: NonNullable<ProjectAsset['render']>['partGroups'] = [];
      for (const p of partKeys) {
        const win = await run(() => window.vv.partWindow(playhead, p.index, p.key), 'Grouping the parts…');
        if (!win) continue;
        const rec = parts.find((x) => x.index === p.index && x.key === p.key);
        members!.push({ group: gid, index: p.index, kind: rec?.kind ?? '', text: rec?.text ?? '', key: p.key, t0: win.t0, t1: win.t1 });
      }
      // A part that was in another group at this time leaves it.
      const isSelected = (g: { index: number; key: string; t0: number; t1: number }) =>
        partKeys.some((p) => p.index === g.index && p.key === g.key) && playhead >= g.t0 - 1e-6 && playhead <= g.t1 + 1e-6;
      const kept = existing.filter((g) => !isSelected(g));
      await mutate(() => window.vv.setRenderOptions(asset.id, { partGroups: [...kept, ...(members ?? [])] }));
    }
  };

  /** Takes the selected layers and parts out of their groups (every member of those groups is taken out). */
  const ungroupSelection = async () => {
    const tracks = project?.doc.timeline.tracks ?? [];
    const asset = htmlAssetOf(project);
    const clips = tracks.flatMap((t) => t.clips);
    const groups = new Set<string>();
    for (const id of selection) {
      const c = clips.find((x) => x.id === id);
      if (c?.group) groups.add(c.group);
    }
    for (const p of partSel) for (const g of asset?.render?.partGroups ?? []) if (g.index === p.index && g.key === p.key) groups.add(g.group);
    if (groups.size === 0) return;
    const ids = clips.filter((c) => c.group && groups.has(c.group)).map((c) => c.id);
    if (ids.length > 0) await applyTimeline((t) => tagClips(t, ids, null));
    if (asset) {
      const kept = (asset.render?.partGroups ?? []).filter((g) => !groups.has(g.group));
      await mutate(() => window.vv.setRenderOptions(asset.id, { partGroups: kept }));
    }
  };

  /**
   * Moves a part by a transform, in the stretch of the video where it is the same part: a group's stored stretch, or the
   * stretch around the playhead (found by the render engine). The part's moves are composed (see composePartOffsets).
   */
  const movePartsBy = async (partKeys: PartKey[], t: { sx: number; sy: number; dx: number; dy: number }) => {
    const asset = htmlAssetOf(project);
    if (!asset) return;
    let offsets = asset.render?.opOffsets ?? [];
    for (const p of partKeys) {
      const member = (asset.render?.partGroups ?? []).find(
        (g) => g.index === p.index && g.key === p.key && playhead >= g.t0 - 1e-6 && playhead <= g.t1 + 1e-6,
      );
      const rec = parts.find((x) => x.index === p.index && x.key === p.key);
      const win = member ? { t0: member.t0, t1: member.t1 } : await run(() => window.vv.partWindow(playhead, p.index, p.key), 'Finding where this part is on screen…');
      if (!win) continue;
      offsets = composePartOffsets(offsets, { index: p.index, key: p.key, kind: member?.kind ?? rec?.kind ?? '', text: member?.text ?? rec?.text ?? '' }, win, t);
    }
    await mutate(() => window.vv.setRenderOptions(asset.id, { opOffsets: offsets }));
  };

  /** Moves the selected items (layers and canvas parts) by an offset in frame pixels. A group moves as one. */
  const moveItems = async (items: Items, dx: number, dy: number) => {
    if (items.layers.length > 0) await applyTimeline((t) => shiftLayers(t, items.layers, dx, dy));
    if (items.parts.length > 0) await movePartsBy(items.parts, { sx: 1, sy: 1, dx, dy });
  };

  /** Resizes the selected items: the box `from` becomes the box `to` (frame pixels). Parts scale with their transform. */
  const scaleItems = async (items: Items, from: Box, to: Box) => {
    if (items.layers.length > 0) await applyTimeline((t) => scaleLayers(t, items.layers, from, to));
    if (items.parts.length > 0) {
      const kx = from.w ? to.w / from.w : 1;
      const ky = from.h ? to.h / from.h : 1;
      await movePartsBy(items.parts, { sx: kx, sy: ky, dx: to.x - kx * from.x, dy: to.y - ky * from.y });
    }
  };

  const exportTimeline = async () => {
    setExporting({ assetId: '__timeline__', id: null, frame: 0, total: 0, percent: 0 });
    const r = await run(() => window.vv.exportComposition({}));
    setExporting(null);
    if (r) {
      applyState(r.state);
      const file = r.render.file.replace(/^renders\//, '');
      const sound = r.render.audioClips ?? 0;
      const soundText = sound > 0 ? `sound from ${sound} clip${sound === 1 ? '' : 's'}` : 'no sound';
      setStatus({ kind: 'info', text: `Exported ${file} (${r.render.frames} frames, ${soundText}).${r.warnings.length ? ' ' + r.warnings.join(' ') : ''}` });
    }
  };

  // ---------- edit element (Stage 7): code, studio, example ----------

  /** Saves the code of the HTML animation (the copy in the project). The preview redraws with the new code. */
  const saveCode = async (text: string) => {
    if (!htmlAssetOf(project)) return false;
    const s = await mutate(() => window.vv.writeAssetText(htmlAssetOf(project)!.id, text));
    if (s) setStatus({ kind: 'info', text: 'Saved the animation code. The preview now shows the change.' });
    return Boolean(s);
  };

  const restoreCode = async () => {
    if (!htmlAssetOf(project)) return false;
    const s = await mutate(() => window.vv.restoreAssetOriginal(htmlAssetOf(project)!.id));
    if (s) setStatus({ kind: 'info', text: 'Put back the original animation.' });
    return Boolean(s);
  };

  /** The element of the animation under a point of the frame, at the playhead (the studio shows it). */
  const inspectAt = async (pt: { x: number; y: number }) => {
    const found = (await run(() => window.vv.inspectElement(playhead * 1000, pt.x, pt.y))) ?? null;
    setInspected(found);
    return found;
  };

  /**
   * Selects a part of the animation from the studio's list: it is shown in the inspector, selected with its group, and can
   * be moved or resized with the selection. Shift-click adds it to the selection, or removes it.
   */
  const selectPart = (part: PartRecord, additive = false) => {
    const [x0, y0, x1, y1] = part.bbox ?? [0, 0, 0, 0];
    const key = { index: part.index, key: part.key };
    const group = expandGroups(project?.doc.timeline.tracks ?? [], htmlRenderOf(project)?.partGroups ?? [], { layers: [], parts: [key] });
    if (!additive) {
      selectItems(group.layers, group.parts);
    } else {
      const isIn = group.parts.every((p) => partSel.some((k) => k.index === p.index && k.key === p.key));
      const parts = isIn
        ? partSel.filter((k) => !group.parts.some((p) => p.index === k.index && p.key === k.key))
        : [...partSel.filter((k) => !group.parts.some((p) => p.index === k.index && p.key === k.key)), ...group.parts];
      selectItems(selection, parts);
    }
    setInspected({
      tag: part.kind,
      id: '',
      classes: [],
      text: part.text,
      html: '',
      selector: `canvas part ${part.index}`,
      rect: { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) },
      op: { index: part.index, kind: part.kind, text: part.text, color: part.color, key: part.key },
    });
  };

  /** Moves a layer forward or backward in its track (the order the layers are drawn in). */
  const reorderLayerAt = (id: string, direction: 'forward' | 'backward') => {
    void applyTimeline((t) => reorderLayer(t, id, direction));
  };

  /** Moves an element of the animation by an offset (frame pixels). The move is saved in the project. */
  const moveElement = (info: ElementInfo, dx: number, dy: number) => {
    const asset = htmlAssetOf(project);
    if (!asset || !project) return;
    if (info.op) {
      void movePartsBy([{ index: info.op.index, key: info.op.key }], { sx: 1, sy: 1, dx, dy });
      return;
    }
    if (coversFrame(info, project)) {
      notify('That is the whole animation canvas, so it is not moved. Its parts are painted on it, and cannot be picked one by one yet.');
      return;
    }
    // An element is kept with its path, its tag and its id: the offset applies only while the element there is this one.
    const tag = info.tag.toLowerCase();
    const id = info.id || '';
    const current = asset.render?.elementOffsets ?? [];
    const same = (o: { selector: string; tag: string; id: string }) => o.selector === info.selector && o.tag === tag && o.id === id;
    const hit = current.find(same);
    const next = hit
      ? current.map((o) => (o === hit ? { ...o, x: o.x + dx, y: o.y + dy } : o))
      : [...current, { selector: info.selector, tag, id, x: dx, y: dy }];
    void mutate(() => window.vv.setRenderOptions(asset.id, { elementOffsets: next.filter((o) => o.x || o.y) }));
  };

  /** Puts an element back where the animation puts it. */
  const resetElement = (selector: string) => {
    const asset = htmlAssetOf(project);
    if (!asset) return;
    const part = /^canvas part (\d+)$/.exec(selector);
    if (part) {
      // The part's move at this time (the stretch of the video that contains the playhead) is removed; other stretches stay.
      const index = Number(part[1]);
      const here = (o: { index: number; t0: number; t1: number }) => o.index === index && playhead >= o.t0 - 1e-6 && playhead <= o.t1 + 1e-6;
      const kept = (asset.render?.opOffsets ?? []).filter((o) => !here(o));
      void mutate(() => window.vv.setRenderOptions(asset.id, { opOffsets: kept }));
      return;
    }
    const kept = (asset.render?.elementOffsets ?? []).filter((o) => o.selector !== selector);
    void mutate(() => window.vv.setRenderOptions(asset.id, { elementOffsets: kept }));
  };

  const openExampleProject = async () => {
    const r = await run(() => window.vv.openExample(), 'Opening the example…');
    if (r) {
      setSelected(null);
      setFolderFilter('all');
      setProject(r.state);
      setNarrateId(r.created ? r.state.doc.id : null);
      notify(r.created ? 'Created the example project.' : 'Opened the example project.');
    }
  };

  // Delete removes the selected clip; S splits it at the playhead. Not while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (!selectedClipId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelected();
      } else if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        splitSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // A different project starts at 0:00 with nothing selected, and with no code or studio open.
  useEffect(() => {
    setSelectedClipId(null);
    setPlayhead(0);
    setCodeOpen(false);
    setStudioOpen(false);
    setInspected(null);
  }, [project?.doc.id]);

  const narrationActions: NarrationActions = {
    create: (p) => mutate(() => window.vv.setNarration(p)),
    settings: (p) => mutate(() => window.vv.setNarrationSettings(p)),
    edit: (id, text) => mutate(() => window.vv.editSegment(id, text)),
    clear: () => mutate(() => window.vv.clearNarration()),
    generate: async (ids?: string[]) => {
      setNarrProgress({ total: 0, done: 0 });
      const r = await run(() => window.vv.generateNarration(ids));
      setNarrProgress(null);
      if (r) {
        applyState(r.state);
        const made = r.done;
        setStatus(
          r.failed > 0
            ? { kind: 'error', text: `${made} segment${made === 1 ? '' : 's'} generated, ${r.failed} failed. See the message under each segment.` }
            : { kind: 'info', text: r.cancelled ? `Stopped after ${made} segment${made === 1 ? '' : 's'}.` : `Generated ${made} segment${made === 1 ? '' : 's'}.` },
        );
      }
      return r;
    },
    cancel: () => void window.vv.cancelNarration(),
    preview: async (voice: string, speed: number) => (await run(() => window.vv.previewVoice(voice, speed)))?.file,
    chooseTts: () => {
      void run(() => window.vv.chooseTtsPython()).then((s) => {
        if (s) setTts(s);
      });
    },
  };

  // The example's narration is made once, as soon as the narration engine is ready.
  useEffect(() => {
    if (narrateId && project?.doc.id === narrateId && tts?.python) {
      setNarrateId(null);
      void narrationActions.generate();
    }
  }, [narrateId, project, tts]); // eslint-disable-line react-hooks/exhaustive-deps

  // The studio lists the parts of the animation at the playhead; the list follows the playhead and the saved changes.
  useEffect(() => {
    if (!studioOpen || !project) return;
    let alive = true;
    window.vv
      .listParts(playhead * 1000)
      .then((list) => alive && setParts(list))
      .catch(() => alive && setParts([]));
    return () => {
      alive = false;
    };
  }, [studioOpen, playhead, project?.savedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const fullScreenExit = fullScreen ? (
    <button className="fullscreen-exit" data-testid="fullscreen-exit" onClick={() => void window.vv.setFullScreen(false)} title="Leave full screen (F11 or Esc)">
      Exit full screen
    </button>
  ) : null;

  if (!ready) return <div className="start"><p className="empty-note">Loading…</p></div>;

  if (!project) {
    return (
      <>
        {fullScreenExit}
        <StartScreen
          recent={recent}
          busy={busy}
          onNew={() => setDialog('new')}
          onOpen={openFromDialog}
          onExample={() => void openExampleProject()}
          onOpenRecent={openDir}
          onForget={forgetRecent}
          onAbout={() => setDialog('about')}
          status={status}
          onDismissStatus={() => setStatus(null)}
        />
        {dialog === 'new' && <NewProjectDialog onCancel={() => setDialog(null)} onCreated={onProjectCreated} />}
        {dialog === 'about' && <AboutDialog info={info} onClose={() => setDialog(null)} />}
      </>
    );
  }

  const selectedAsset = project.doc.assets.find((a) => a.id === selected) ?? null;
  // The inspector shows one clip; with several layers selected the studio shows the selection panel instead.
  const selectedClip = selection.length === 1 && partSel.length === 0 ? findClip(project.doc.timeline.tracks, selection[0]) : null;
  const durationNow = project.doc.settings.durationSec;
  const htmlAsset = htmlAssetOf(project);
  const clipInspectorNode = selectedClip ? (
    <ClipInspector
      clip={selectedClip}
      tracks={project.doc.timeline.tracks}
      assets={project.doc.assets}
      playhead={playhead}
      onUpdate={(patch) => void applyTimeline((t) => updateClip(t, selectedClip.id, patch, durationNow))}
      onMoveTrack={(track) => void applyTimeline((t) => moveClip(t, selectedClip.id, { track }, durationNow))}
      onSplit={splitSelected}
      onDelete={deleteSelected}
      onBack={() => setSelectedClipId(null)}
    />
  ) : null;

  return (
    <>
      {fullScreenExit}
      <div className="app">
        <div className="panel area-top">
          <ProjectBar
            name={project.doc.name}
            savedAt={project.savedAt}
            onImport={importFromDialog}
            onSave={saveNow}
            onReveal={() => void run(() => window.vv.revealProject())}
            onClose={closeProject}
            onAbout={() => setDialog('about')}
          />
        </div>
        <div className="panel area-assets">
          <AssetLibrary
            project={project}
            selectedId={selected}
            onSelect={(id) => {
              setSelected(id);
              if (id) setSelectedClipId(null);
            }}
            folderFilter={folderFilter}
            onFolderFilter={setFolderFilter}
            onImport={importFromDialog}
            onDropPaths={importPaths}
            onCreateFolder={(name) => mutate(() => window.vv.createFolder(name))}
            onRenameFolder={(id, name) => mutate(() => window.vv.renameFolder(id, name))}
            onDeleteFolder={(id) => mutate(() => window.vv.deleteFolder(id))}
          />
        </div>
        <div className="panel area-preview">
          {selectedAsset ? (
            <PreviewPanel project={project} asset={selectedAsset} />
          ) : (
            <CompositionPreview
              project={project}
              playhead={playhead}
              onSeek={setPlayhead}
              selectedIds={selection}
              selectedParts={partSel}
              parts={parts}
              onSelect={selectItems}
              onMoveItems={moveItems}
              onScaleItems={scaleItems}
              onMenu={(x, y) => setMenuAt({ x, y })}
            />
          )}
        </div>
        <div className="panel area-inspector">
          {codeOpen && htmlAsset ? (
            <CodeEditor asset={htmlAsset} onSave={saveCode} onRestore={restoreCode} onClose={() => setCodeOpen(false)} />
          ) : selectedClip ? (
            clipInspectorNode
          ) : (
          <InspectorPanel
            project={project}
            asset={selectedAsset}
            exporting={exporting}
            ffmpeg={ffmpeg}
            narration={{
              voices,
              speedRange,
              tts,
              progress: narrProgress,
              actions: narrationActions,
            }}
            onSetRenderOptions={(id, opts: Partial<RenderOptions>) => mutate(() => window.vv.setRenderOptions(id, opts))}
            onExport={(assetId) => void startExport(assetId)}
            onCancelExport={(id) => void window.vv.cancelExport(id)}
            onChooseFfmpeg={() => void chooseFfmpeg()}
            onRevealRender={(file) => void run(() => window.vv.revealRender(file))}
            onClearSelection={() => setSelected(null)}
            onUpdateSettings={(patch) => mutate(() => window.vv.updateSettings(patch))}
            onRenameProject={(name) => mutate(() => window.vv.renameProject(name))}
            onRenameAsset={(id, name) => mutate(() => window.vv.renameAsset(id, name))}
            onMoveAsset={(id, folderId) => mutate(() => window.vv.moveAsset(id, folderId))}
            onRemoveAsset={async (id) => {
              const s = await mutate(() => window.vv.removeAsset(id));
              if (s) notify('Removed from the project. The original file on your computer is unchanged.');
            }}
            onReveal={() => void run(() => window.vv.revealProject())}
          />
          )}
        </div>
        <div className="panel area-timeline">
          <TimelinePanel
            settings={project.doc.settings}
            tracks={project.doc.timeline.tracks}
            playhead={playhead}
            selectedId={selectedClipId}
            onSelect={selectClip}
            onSeek={setPlayhead}
            onTracks={(tracks: TimelineTrack[]) => void applyTimeline(() => tracks)}
            onAdd={addAtPlayhead}
            onSplit={splitSelected}
            onDelete={deleteSelected}
            onDuration={(durationSec) => mutate(() => window.vv.updateSettings({ durationSec }))}
            onExport={() => void exportTimeline()}
            exporting={timelineExporting}
          />
        </div>
        <div className="area-status">
          <StatusLine status={status} onDismiss={() => setStatus(null)} busy={busy} />
        </div>
      </div>
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          title="Edit element"
          onClose={() => setMenuAt(null)}
          items={[
            {
              testId: 'edit-code',
              label: 'Show code in the inspector',
              hint: htmlAsset ? htmlAsset.name : 'Needs an HTML animation on the timeline',
              disabled: !htmlAsset,
              onSelect: () => {
                setSelectedClipId(null);
                setSelected(null);
                setCodeOpen(true);
              },
            },
            {
              testId: 'open-studio',
              label: 'Open studio',
              hint: 'Click elements, add boxes, circles and text',
              onSelect: () => {
                setInspected(null);
                setStudioOpen(true);
              },
            },
          ]}
        />
      )}
      {studioOpen && (
        <Studio
          project={project}
          playhead={playhead}
          onSeek={setPlayhead}
          selectedIds={selection}
          selectedParts={partSel}
          onSelect={selectItems}
          onMoveItems={moveItems}
          onScaleItems={scaleItems}
          onPickLayer={pickLayer}
          onGroup={() => void groupSelection()}
          onUngroup={() => void ungroupSelection()}
          onImportSnippet={importSnippet}
          onAdd={addAtPlayhead}
          onDelete={deleteSelected}
          inspected={inspected}
          onInspect={inspectAt}
          parts={parts}
          onSelectPart={(part, additive) => selectPart(part, additive)}
          onReorder={reorderLayerAt}
          onElementMove={moveElement}
          onResetElement={resetElement}
          htmlAsset={htmlAsset}
          clipInspector={clipInspectorNode}
          onShowCode={() => {
            setStudioOpen(false);
            setCodeOpen(true);
          }}
          onClose={() => setStudioOpen(false)}
        />
      )}
      {dialog === 'new' && <NewProjectDialog onCancel={() => setDialog(null)} onCreated={onProjectCreated} />}
      {dialog === 'about' && <AboutDialog info={info} onClose={() => setDialog(null)} />}
      {dialog === 'master' && <MasterPromptDialog onClose={() => setDialog(null)} />}
    </>
  );
}
