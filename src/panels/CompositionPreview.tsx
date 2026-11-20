import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Pause, Play, Square, StepBack, StepForward } from 'lucide-react';
import type { ElementInfo, PartKey, PartRecord, ProjectState } from '../model/types';
import { formatTimecode, projectFileUrl } from '../model/format';
import { expandGroups, layerStates, scaledRect } from '../../shared/timeline.mjs';
import { aspectById } from '../../shared/project-format.mjs';
import { ZoomStage } from './ZoomStage';

/** The grid and rulers of the studio: shown over the frame, and drags snap to the grid when snap is on. */
export interface GridSettings {
  show: boolean;
  snap: boolean;
  size: number;
}

/** A rectangle in frame pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What is selected or moved together: layers (clip ids) and canvas parts (number and key). */
export interface Items {
  layers: string[];
  parts: PartKey[];
}

/** A layer as the frame shows it at the playhead (see layerStates in shared/timeline.mjs). */
interface LayerBox extends Box {
  id: string;
  kind: string;
  track: string;
  z: number;
  visible: boolean;
  group: string | null;
}

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

/** A move or resize in progress: the items show as if they were at `to` (they were in `from`). */
interface View {
  items: Items;
  from: Box;
  to: Box;
}

interface Props {
  project: ProjectState;
  /** The grid and snapping (studio). Without it, nothing snaps and no grid is drawn. */
  grid?: GridSettings;
  playhead: number;
  onSeek(sec: number): void;
  /** The selected layers and canvas parts. A group is always selected whole. */
  selectedIds: string[];
  selectedParts: PartKey[];
  /** The canvas parts drawn at the playhead, with their boxes (from the render engine). */
  parts: PartRecord[];
  /** Selects layers and parts. Empty lists clear the selection. */
  onSelect(layers: string[], parts: PartKey[]): void;
  /** Moves items (layers and parts together) by an offset in frame pixels. */
  onMoveItems(items: Items, dx: number, dy: number): void;
  /** Resizes items: the box `from` becomes the box `to` (frame pixels). */
  onScaleItems(items: Items, from: Box, to: Box): void;
  /** Right-click on the frame, at the pointer's screen position. */
  onMenu?(x: number, y: number): void;
  /**
   * In the studio: a press on the animation where no layer is (frame pixels). It finds what is under the point: a canvas
   * part (selected, and dragged with the selection), a DOM element (dragged to move it), or nothing (a drag on empty space,
   * or on the whole canvas, draws a selection rectangle).
   */
  onInspect?(pt: { x: number; y: number }): Promise<ElementInfo | null> | void;
  /** A DOM element of the animation dragged to a new place: its offset in frame pixels. */
  onElementMove?(info: ElementInfo, dx: number, dy: number): void;
}

/** The smallest rectangle around a list of rectangles, or null for an empty list. */
export function boxOf(list: Box[]): Box | null {
  if (list.length === 0) return null;
  const x0 = Math.min(...list.map((r) => r.x));
  const y0 = Math.min(...list.map((r) => r.y));
  const x1 = Math.max(...list.map((r) => r.x + r.w));
  const y1 = Math.max(...list.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const sameKey = (a: PartKey, b: PartKey) => a.index === b.index && a.key === b.key;
const hasPart = (list: PartKey[], p: PartKey) => list.some((k) => sameKey(k, p));

/** The rectangle spanned by two points. */
function rectBetween(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** True when two rectangles share some area (touching edges do not count). */
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** A corner's moving edge keeps at least 4 px from the opposite corner, so the box never collapses. */
function keepApart(anchor: number, v: number): number {
  return Math.abs(v - anchor) < 4 ? anchor + (v >= anchor ? 4 : -4) : v;
}

/** The items of a selection: the layers and parts that are in both lists. */
const withoutItems = (current: Items, drop: Items): Items => ({
  layers: current.layers.filter((id) => !drop.layers.includes(id)),
  parts: current.parts.filter((p) => !hasPart(drop.parts, p)),
});
const withItems = (current: Items, add: Items): Items => ({
  layers: [...current.layers.filter((id) => !add.layers.includes(id)), ...add.layers],
  parts: [...current.parts.filter((p) => !hasPart(add.parts, p)), ...add.parts],
});

/**
 * The timeline as the export draws it: the HTML animation (if any) with every layer, at the playhead.
 * Frames come from the render engine, so this is what the video will show at this time.
 */
export function CompositionPreview({
  project,
  playhead,
  onSeek,
  selectedIds,
  selectedParts,
  parts,
  onSelect,
  onMoveItems,
  onScaleItems,
  onMenu,
  onInspect,
  onElementMove,
  grid,
}: Props) {
  // Snapping engages only when a value is within 6 screen pixels of a grid line, so a drag follows the pointer everywhere
  // else. (Snapping every move to the grid made a drag jump by up to half a grid cell.)
  const snapTolerance = () => {
    const r = frameRef.current?.getBoundingClientRect();
    return r && r.width ? (6 * W) / r.width : 6;
  };
  const nearGrid = (v: number) => {
    const size = grid?.size ?? 50;
    const g = Math.round(v / size) * size;
    return Math.abs(g - v) <= snapTolerance() ? g : v;
  };
  const snapV = (v: number) => Math.round(grid?.snap ? nearGrid(v) : v);
  const snapD = (origin: number, d: number) => Math.round(grid?.snap ? nearGrid(origin + d) - origin : d);
  // The element being dragged: its rectangle in frame pixels, and how far it has moved so far.
  const [ghost, setGhost] = useState<{ rect: ElementInfo['rect']; dx: number; dy: number } | null>(null);
  // A move or resize in progress, and the selection rectangle of a drag on empty space.
  const [view, setView] = useState<View | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const s = project.doc.settings;
  const aspect = aspectById(s.aspect);
  const W = aspect?.width ?? 1080;
  const H = aspect?.height ?? 1920;
  const total = s.durationSec;
  const frameMs = 1000 / s.fps;
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const flight = useRef<Promise<void> | null>(null);
  const wanted = useRef<number | null>(null);
  const alive = useRef(true);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  // The sound of the timeline (a mix made by the main process). It plays with the frames.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const soundFile = useRef<string | null>(null);
  const [soundNote, setSoundNote] = useState<string | null>(null);

  /** Starts the sound at `from`. The file is made (or reused) by the main process from the timeline's audio. */
  const startSound = async (from: number) => {
    const a = audioRef.current;
    try {
      const r = await window.vv.previewAudio();
      setSoundNote(null);
      if (!a) return;
      if (!r.file) {
        a.removeAttribute('src');
        soundFile.current = null;
        return; // no audio on the timeline: nothing to play
      }
      if (soundFile.current !== r.file) {
        soundFile.current = r.file;
        a.src = projectFileUrl(r.file);
        a.load();
      }
      a.currentTime = from;
      await a.play();
    } catch (err) {
      setSoundNote(err instanceof Error ? err.message : 'The sound could not be played.');
    }
  };

  // One request at a time; while one is in flight only the newest time is kept.
  const renderAt = useCallback((ms: number): Promise<void> => {
    wanted.current = Math.max(0, Math.min(total * 1000, ms));
    if (flight.current) return flight.current;
    const run = async () => {
      while (alive.current && wanted.current !== null) {
        const next = wanted.current;
        wanted.current = null;
        setBusy(true);
        try {
          const r = await window.vv.renderComposition(next);
          if (!alive.current) return;
          setFrame(`data:image/png;base64,${r.png}`);
          setError(null);
          setWarnings(r.warnings);
        } catch (err) {
          if (alive.current) setError(err instanceof Error ? err.message : String(err));
        }
      }
      setBusy(false);
    };
    flight.current = run().finally(() => {
      flight.current = null;
    });
    return flight.current;
  }, [total]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Show the frame for the playhead; re-draw after every saved change (a layer may have moved).
  useEffect(() => {
    if (!playing) void renderAt(playhead * 1000);
  }, [playhead, playing, project.savedAt, renderAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sound follows play and pause (a seek or a stop pauses it too, since it sets playing to false).
  useEffect(() => {
    if (!playing) audioRef.current?.pause();
  }, [playing]);

  // Playback follows the sound's clock once it runs; otherwise the wall clock. When rendering is slower than real time,
  // frames are skipped.
  useEffect(() => {
    if (!playing) return;
    const wall0 = performance.now();
    const t0 = playheadRef.current;
    let stopped = false;
    (async () => {
      while (!stopped && alive.current) {
        const a = audioRef.current;
        const fromSound = a && !a.paused && a.currentTime > 0.05 ? a.currentTime : null;
        const target = Math.min(total, fromSound ?? t0 + (performance.now() - wall0) / 1000);
        onSeekRef.current(Math.round(target * 100) / 100);
        await renderAt(target * 1000);
        if (target >= total) {
          setPlaying(false);
          break;
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [playing, total, renderAt]);

  const tracks = project.doc.timeline.tracks;
  // The groups of canvas parts, from the project's render options (the html animation's).
  const partGroups = useMemo(() => {
    const clip = tracks.flatMap((t) => t.clips).find((c) => c.kind === 'html');
    const asset = clip ? project.doc.assets.find((a) => a.id === clip.assetId) : undefined;
    return asset?.render?.partGroups ?? [];
  }, [tracks, project.doc.assets]);
  const layers = useMemo(() => layerStates(tracks, playhead).layers as LayerBox[], [tracks, playhead]);
  const visible = layers.filter((l) => l.visible);
  const frameIndex = Math.round(playhead * s.fps);
  // The canvas parts that can be picked: a part that covers (almost) the whole frame is the background.
  const pickable = parts.filter((p) => {
    if (!p.bbox) return false;
    return (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]) < W * H * 0.9;
  });
  const partBox = (p: PartRecord): Box => {
    const [x0, y0, x1, y1] = p.bbox as [number, number, number, number];
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  // The boxes of the selected items as they are now (or as a move or resize shows them).
  const shownOf = (l: LayerBox): Box => (view && view.items.layers.includes(l.id) ? scaledRect(l, view.from, view.to) : l);
  const shownPartOf = (p: PartRecord): Box => {
    const r = partBox(p);
    return view && hasPart(view.items.parts, { index: p.index, key: p.key }) ? scaledRect(r, view.from, view.to) : r;
  };
  const selLayers = visible.filter((l) => selectedIds.includes(l.id));
  const selParts = pickable.filter((p) => hasPart(selectedParts, { index: p.index, key: p.key }));
  const selBox = boxOf([...selLayers, ...selParts.map(partBox)]);
  const shownBox = view ? view.to : selBox;
  const selCount = selLayers.length + selParts.length;

  const toFrame = (clientX: number, clientY: number) => {
    const r = frameRef.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H };
  };

  const hit = (pt: { x: number; y: number }) => {
    let best: LayerBox | null = null;
    for (const l of visible) {
      if (pt.x >= l.x && pt.x <= l.x + l.w && pt.y >= l.y && pt.y <= l.y + l.h && (!best || l.z > best.z)) best = l;
    }
    return best;
  };

  /** The boxes of a list of items (the parts and layers at the playhead). */
  const boxOfItems = (items: Items): Box | null =>
    boxOf([...visible.filter((l) => items.layers.includes(l.id)), ...pickable.filter((p) => hasPart(items.parts, { index: p.index, key: p.key })).map(partBox)]);

  const onDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const pt = toFrame(e.clientX, e.clientY);
    const l = hit(pt);
    if (l) return startSelectionDrag(l, pt, e.shiftKey);
    if (!e.shiftKey) onSelect([], []);
    startEmptyDrag(pt, e.shiftKey);
  };

  /**
   * A press on a layer. Clicking it selects its group whole, and a drag moves the selection (the layers and parts selected).
   * Shift-click adds the group, or removes it when it is in. The drag snaps the selection's top-left corner to the grid.
   */
  const startSelectionDrag = (l: LayerBox, pt: { x: number; y: number }, additive: boolean) => {
    if (additive) {
      const group = expandGroups(tracks, partGroups, { layers: [l.id], parts: [] });
      const current: Items = { layers: selectedIds, parts: selectedParts };
      const isIn = group.layers.every((id) => selectedIds.includes(id)) && group.parts.every((p) => hasPart(selectedParts, p));
      const next = isIn ? withoutItems(current, group) : withItems(current, group);
      onSelect(next.layers, next.parts);
      return;
    }
    const already = selectedIds.includes(l.id);
    const items: Items = already ? { layers: selectedIds, parts: selectedParts } : expandGroups(tracks, partGroups, { layers: [l.id], parts: [] });
    if (!already) onSelect(items.layers, items.parts);
    const box = boxOfItems(items);
    if (box) startDrag(items, pt, box);
  };

  /** Moves a list of items by the pointer's movement (snapped), showing them as they go; the move is saved on release. */
  const startDrag = (items: Items, pt: { x: number; y: number }, box: Box) => {
    let moved = false;
    let d = { dx: 0, dy: 0 };
    const move = (ev: PointerEvent) => {
      const p2 = toFrame(ev.clientX, ev.clientY);
      const rawDx = Math.round(p2.x - pt.x);
      const rawDy = Math.round(p2.y - pt.y);
      if (!moved && Math.hypot(rawDx, rawDy) < 3) return;
      moved = true;
      d = { dx: snapD(box.x, rawDx), dy: snapD(box.y, rawDy) };
      setView({ items, from: box, to: { ...box, x: box.x + d.dx, y: box.y + d.dy } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setView(null);
      if (moved && (d.dx || d.dy)) onMoveItems(items, d.dx, d.dy);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * A handle at a corner of the selection: dragging it resizes the selected items together. The opposite corner stays
   * where it is; each item keeps its place inside the box.
   */
  const startResize = (corner: Corner, e: ReactPointerEvent) => {
    if (!selBox) return;
    e.stopPropagation();
    const items: Items = { layers: selectedIds, parts: selParts.map((p) => ({ index: p.index, key: p.key })) };
    const from = selBox;
    const right = corner === 'ne' || corner === 'se';
    const bottom = corner === 'se' || corner === 'sw';
    const ax = right ? from.x : from.x + from.w; // the anchor: the corner opposite the one being dragged
    const ay = bottom ? from.y : from.y + from.h;
    let moved = false;
    let to = from;
    const move = (ev: PointerEvent) => {
      const p = toFrame(ev.clientX, ev.clientY);
      const nx = keepApart(ax, snapV(p.x));
      const ny = keepApart(ay, snapV(p.y));
      moved = true;
      to = { x: Math.min(ax, nx), y: Math.min(ay, ny), w: Math.abs(nx - ax), h: Math.abs(ny - ay) };
      setView({ items, from, to });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setView(null);
      if (moved) onScaleItems(items, from, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * A press where no layer is. In the studio the press is looked up: on a canvas part it selects the part (with its group)
   * and a drag moves the selection; on a DOM element a drag moves the element (saved on release); on empty space, or on the
   * whole canvas, a drag draws a selection rectangle that selects what it touches. A plain click selects what is under it.
   */
  const startEmptyDrag = (pt: { x: number; y: number }, additive: boolean) => {
    let found = null as ElementInfo | null;
    let lookedUp = !onInspect;
    let mode = (onInspect ? 'pending' : 'marquee') as 'pending' | 'part' | 'element' | 'marquee';
    let moved = false;
    let cur = pt;
    let last = { dx: 0, dy: 0 };
    let items: Items = { layers: [], parts: [] };
    let box: Box | null = null;
    let partKey: PartKey | null = null;
    const decide = () => {
      if (mode !== 'pending') return;
      if (found?.op) {
        mode = 'part';
        partKey = { index: found.op.index, key: found.op.key };
        const inSelection = hasPart(selectedParts, partKey);
        // A part that is selected moves the selection; another part is selected with its group, and moves alone.
        items = inSelection && !additive ? { layers: selectedIds, parts: selectedParts } : expandGroups(tracks, partGroups, { layers: [], parts: [partKey] });
        box = boxOfItems(items) ?? boxOf([found.rect]);
      } else {
        mode = !found || (found.rect.w >= W * 0.9 && found.rect.h >= H * 0.9) ? 'marquee' : 'element';
      }
    };
    // Shows what the drag does so far; waits for the element lookup first.
    const update = () => {
      if (!moved || !lookedUp) return;
      decide();
      if (mode === 'marquee') {
        setMarquee(rectBetween(pt, cur));
      } else if (mode === 'part' && box) {
        const dx = snapD(box.x, Math.round(cur.x - pt.x));
        const dy = snapD(box.y, Math.round(cur.y - pt.y));
        last = { dx, dy };
        setView({ items, from: box, to: { ...box, x: box.x + dx, y: box.y + dy } });
      } else if (mode === 'element' && found) {
        // A DOM element snaps by its own corner (its top-left) to the grid.
        last = { dx: snapD(found.rect.x, Math.round(cur.x - pt.x)), dy: snapD(found.rect.y, Math.round(cur.y - pt.y)) };
        setGhost({ rect: found.rect, dx: last.dx, dy: last.dy });
      }
    };
    const looking = Promise.resolve(onInspect?.(pt)).then((info) => {
      found = info ?? null;
      lookedUp = true;
      update();
    });
    const move = (ev: PointerEvent) => {
      cur = toFrame(ev.clientX, ev.clientY);
      if (!moved && Math.hypot(cur.x - pt.x, cur.y - pt.y) < 3) return;
      moved = true;
      update();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGhost(null);
      setMarquee(null);
      setView(null);
      void looking.then(() => {
        decide();
        if (mode === 'part' && partKey) {
          if (!moved) {
            // A click on a part selects it (with its group); shift-click adds it or removes it.
            const group = expandGroups(tracks, partGroups, { layers: [], parts: [partKey] });
            if (additive) {
              const isIn = group.parts.every((p) => hasPart(selectedParts, p));
              const next = isIn ? withoutItems({ layers: selectedIds, parts: selectedParts }, group) : withItems({ layers: selectedIds, parts: selectedParts }, group);
              onSelect(next.layers, next.parts);
            } else {
              onSelect(items.layers, items.parts);
            }
            return;
          }
          if (!additive) onSelect(items.layers, items.parts);
          if (last.dx || last.dy) onMoveItems(items, last.dx, last.dy);
          return;
        }
        if (!moved) return;
        if (mode === 'marquee') {
          // The layers and parts the rectangle touches, with their groups; shift keeps the earlier selection.
          const r = rectBetween(pt, cur);
          const touched = expandGroups(
            tracks,
            partGroups,
            {
              layers: visible.filter((l) => overlaps(l, r)).map((l) => l.id),
              parts: pickable.filter((p) => overlaps(partBox(p), r)).map((p) => ({ index: p.index, key: p.key })),
            },
          );
          const next = additive ? withItems({ layers: selectedIds, parts: selectedParts }, touched) : touched;
          onSelect(next.layers, next.parts);
        } else if (mode === 'element' && found && (last.dx || last.dy)) {
          onElementMove?.(found, last.dx, last.dy);
        }
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** The rectangle of a box as CSS percentages of the frame. */
  const pct = (r: Box) =>
    ({ left: `${(r.x / W) * 100}%`, top: `${(r.y / H) * 100}%`, width: `${(r.w / W) * 100}%`, height: `${(r.h / H) * 100}%` }) as CSSProperties;

  // The outlines of the selected items: one each when several are selected, and the box around them all.
  const selOutlines = [...selLayers.map(shownOf), ...selParts.map(shownPartOf)];

  return (
    <>
      <div className="panel-head">
        <h2>Preview</h2>
        <span className="count">
          {s.aspect} · {W} × {H} · timeline
        </span>
      </div>
      <div className="preview-stage">
        <ZoomStage frameWidth={W}>
        <div
          ref={frameRef}
          className="frame"
          style={{ '--w': W, '--h': H } as CSSProperties}
          data-testid="composition-frame"
          onPointerDown={onDown}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu?.(e.clientX, e.clientY);
          }}
        >
          {frame ? (
            <img src={frame} alt={`Timeline at ${formatTimecode(playhead, true)}`} draggable={false} />
          ) : (
            <div className="placeholder">
              <span>{error ?? 'Rendering preview…'}</span>
            </div>
          )}
          {selCount > 1 &&
            selOutlines.map((r, i) => <div key={i} className="layer-outline item" style={pct(r)} data-testid="layer-outline-item" />)}
          {shownBox && <div className="layer-outline" style={pct(shownBox)} data-testid="layer-outline" />}
          {shownBox &&
            !marquee &&
            CORNERS.map((c) => {
              const right = c.endsWith('e');
              const bottom = c.startsWith('s');
              const x = right ? shownBox.x + shownBox.w : shownBox.x;
              const y = bottom ? shownBox.y + shownBox.h : shownBox.y;
              return (
                <div
                  key={c}
                  className={`layer-handle ${c}`}
                  data-handle={c}
                  data-testid={`layer-handle-${c}`}
                  style={{ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` }}
                  onPointerDown={(e) => {
                    if (e.button === 0) startResize(c, e);
                  }}
                />
              );
            })}
          {marquee && <div className="marquee" data-testid="marquee" style={pct(marquee)} />}
          {grid?.show && <div className="grid-overlay" style={{ backgroundSize: `${(grid.size / W) * 100}% ${(grid.size / H) * 100}%` }} />}
          {grid?.show && <FrameRulers width={W} height={H} />}
          {ghost && (
            <div
              className="element-ghost"
              data-testid="element-ghost"
              style={{
                left: `${((ghost.rect.x + ghost.dx) / W) * 100}%`,
                top: `${((ghost.rect.y + ghost.dy) / H) * 100}%`,
                width: `${(ghost.rect.w / W) * 100}%`,
                height: `${(ghost.rect.h / H) * 100}%`,
              }}
            />
          )}
          {busy && frame && <span className="render-dot" aria-label="Rendering" />}
        </div>
        </ZoomStage>
      </div>
      <div className="transport" role="group" aria-label="Playback">
        <button className="btn icon ghost" aria-label="Stop" title="Stop and return to 0:00" onClick={() => { setPlaying(false); onSeek(0); }}>
          <Square size={14} />
        </button>
        <button className="btn icon ghost" aria-label="Previous frame" title="Previous frame" onClick={() => { setPlaying(false); onSeek(Math.max(0, frameIndex - 1) / s.fps); }}>
          <StepBack size={16} />
        </button>
        <button
          className="btn icon primary"
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause' : 'Play'}
          onClick={() => {
            if (playing) return setPlaying(false);
            const from = playhead >= total ? 0 : playhead;
            if (playhead >= total) onSeek(0);
            void startSound(from);
            setPlaying(true);
          }}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button className="btn icon ghost" aria-label="Next frame" title="Next frame" onClick={() => { setPlaying(false); onSeek(Math.min(total, (frameIndex + 1) / s.fps)); }}>
          <StepForward size={16} />
        </button>
        <input
          type="range"
          className="scrubber"
          min={0}
          max={total * 1000}
          step={frameMs}
          value={playhead * 1000}
          aria-label="Playhead"
          onChange={(e) => {
            setPlaying(false);
            onSeek(Number(e.target.value) / 1000);
          }}
        />
        <span className="timecode">
          {formatTimecode(playhead, true)} / {formatTimecode(total, true)} · frame {frameIndex}
        </span>
      </div>
      {warnings.length > 0 && <p className="preview-warning">{warnings.join(' ')}</p>}
      {soundNote && <p className="preview-warning" data-testid="sound-note">{soundNote}</p>}
      <audio ref={audioRef} preload="auto" aria-hidden="true" data-testid="preview-sound" />

    </>
  );
}

/** Rulers along the top and left of the frame, labelled in frame pixels every 100 px. */
function FrameRulers({ width, height }: { width: number; height: number }) {
  const labels = [];
  for (let x = 0; x <= width; x += 100) labels.push(<span key={`x${x}`} className="ruler-x" style={{ left: `${(x / width) * 100}%` }}>{x}</span>);
  for (let y = 100; y <= height; y += 100) labels.push(<span key={`y${y}`} className="ruler-y" style={{ top: `${(y / height) * 100}%` }}>{y}</span>);
  return <div className="rulers" aria-hidden="true">{labels}</div>;
}
