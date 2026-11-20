import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Film, Image as ImageIcon, Layers, Lock, Mic, Music, Scissors, Square, Type, Circle, Minus, ArrowRight, Video, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react';
import type { ProjectSettings, TimelineClip, TimelineTrack } from '../model/types';
import { formatTimecode, rulerStep } from '../model/format';
import { moveClip, trimClip } from '../../shared/timeline.mjs';
import { MAX_DURATION_SEC, MIN_DURATION_SEC } from '../../shared/project-format.mjs';

const TRACK_ICON: Record<string, LucideIcon> = { html: Film, visual: Layers, text: Type, narration: Mic, music: Music };
const HEAD_WIDTH = 200; // must match .tl-head width in styles.css
const RULER_HEIGHT = 28;
const TRACK_HEIGHT = 34;
const ZOOM_MIN = 10;
const ZOOM_MAX = 200;
const EDGE_PX = 7;
const ROW_H = 30; // one row of clips inside a track (a track grows to show several rows)

/**
 * Puts overlapping clips of one track into rows, so that none hides another (the first row that is free at a clip's
 * start takes it). Returns the row of each clip id.
 */
function packRows(clips: Array<{ id: string; s: number; e: number }>): Map<string, number> {
  const ends: number[] = [];
  const rows = new Map<string, number>();
  for (const c of [...clips].sort((a, b) => a.s - b.s)) {
    let r = ends.findIndex((end) => end <= c.s + 1e-9);
    if (r === -1) {
      r = ends.length;
      ends.push(c.e);
    } else {
      ends[r] = c.e;
    }
    rows.set(c.id, r);
  }
  return rows;
}

export type AddKind = 'text' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'image' | 'music' | 'html';

interface Props {
  settings: ProjectSettings;
  tracks: TimelineTrack[];
  playhead: number;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onSeek(sec: number): void;
  onTracks(tracks: TimelineTrack[]): void;
  onAdd(kind: AddKind): void;
  onSplit(): void;
  onDelete(): void;
  onDuration(durationSec: number): Promise<unknown>;
  onExport(): void;
  exporting: boolean;
}

type DragMode = 'move' | 'trim-start' | 'trim-end';
interface Drag {
  id: string;
  mode: DragMode;
  x0: number;
  y0: number;
  start0: number;
  end0: number;
  start: number;
  end: number;
  track: string;
  moved: boolean;
}

function clipLabel(c: TimelineClip): string {
  if (c.kind === 'text') return c.text || 'Text';
  if (c.kind === 'shape') return `${c.shape ?? 'shape'}`;
  if (c.kind === 'html') return c.name || 'HTML animation';
  if (c.kind === 'snippet') return c.name || 'HTML element';
  return c.name || c.kind;
}

export function TimelinePanel(p: Props) {
  const [zoom, setZoom] = useState(40); // pixels per second
  const [draft, setDraft] = useState(String(p.settings.durationSec));
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const tracksRef = useRef(p.tracks);
  tracksRef.current = p.tracks;
  const cb = useRef(p);
  cb.current = p;
  const total = p.settings.durationSec;
  // The lane is as long as the project, or as long as its last clip when a clip runs past the end.
  const timelineEnd = Math.max(total, ...p.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
  const laneWidth = Math.round(timelineEnd * zoom) + 160;
  const step = rulerStep(zoom);
  const ticks: number[] = [];
  for (let t = 0; t <= total + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);
  const hasClips = p.tracks.some((t) => t.clips.length > 0);

  useEffect(() => setDraft(String(total)), [total]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  /** Pointer tracking for moving and trimming a clip. Commits once, on release. */
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (e.clientX - d.x0) / zoom;
      const dy = e.clientY - d.y0;
      const moved = d.moved || Math.abs(e.clientX - d.x0) > 3 || Math.abs(dy) > 3;
      let next: Drag = { ...d, moved };
      if (d.mode === 'move') {
        const start = Math.max(0, Math.round((d.start0 + dx) * 20) / 20);
        const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-track]') as HTMLElement | null;
        const track = under?.dataset.track ?? d.track;
        next = { ...next, start, end: start + (d.end0 - d.start0), track };
      } else if (d.mode === 'trim-start') {
        const start = Math.min(Math.max(0, Math.round((d.start0 + dx) * 20) / 20), d.end0 - 0.1);
        next = { ...next, start, end: d.end0 };
      } else {
        const end = Math.min(Math.max(d.start0 + 0.1, Math.round((d.end0 + dx) * 20) / 20), total);
        next = { ...next, start: d.start0, end };
      }
      dragRef.current = next;
      setDrag(next);
    };
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      if (!d.moved) {
        cb.current.onSelect(d.id);
        return;
      }
      try {
        let next = tracksRef.current;
        if (d.mode === 'move') {
          const current = next.flatMap((t) => t.clips).find((c) => c.id === d.id);
          if (current && (current.start !== d.start || current.track !== d.track)) {
            next = moveClip(next, d.id, { start: d.start, track: d.track }, total);
          }
        } else if (d.mode === 'trim-start') {
          next = trimClip(next, d.id, { edge: 'start', time: d.start }, total);
        } else {
          next = trimClip(next, d.id, { edge: 'end', time: d.end }, total);
        }
        cb.current.onSelect(d.id);
        cb.current.onTracks(next);
      } catch (err) {
        fail(err);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [zoom, total]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = (e: ReactPointerEvent, c: TimelineClip, mode: DragMode, trackId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (c.kind === 'audio' && c.segmentId && mode !== 'move') {
      p.onSelect(c.id); // a narration clip moves, but its length is the audio's: no trimming here
      return;
    }
    const d: Drag = {
      id: c.id, mode, x0: e.clientX, y0: e.clientY,
      start0: c.start, end0: c.start + c.duration, start: c.start, end: c.start + c.duration,
      track: trackId, moved: false,
    };
    dragRef.current = d;
    setDrag(d);
  };

  const seekAt = (clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // The playhead sits on the frame grid, so the timecode and the frame number agree.
    const fps = p.settings.fps;
    const t = (clientX - rect.left) / zoom;
    p.onSeek(Math.min(total, Math.max(0, Math.round(t * fps) / fps)));
  };

  const shown = (c: TimelineClip) => {
    if (drag && drag.id === c.id) return { start: drag.start, duration: drag.end - drag.start };
    return { start: c.start, duration: c.duration };
  };

  return (
    <>
      <div className="panel-head">
        <h2>Timeline</h2>
        <span className="count">
          {total} s · {p.settings.fps} fps
        </span>
        <div className="add-tools" role="toolbar" aria-label="Add to the timeline">
          <button className="btn" onClick={() => p.onAdd('text')} data-testid="add-text" title="Add text at the playhead">
            <Type size={14} /> Text
          </button>
          <button className="btn" onClick={() => p.onAdd('rect')} data-testid="add-rect" title="Add a rectangle">
            <Square size={14} /> Box
          </button>
          <button className="btn" onClick={() => p.onAdd('ellipse')} data-testid="add-ellipse" title="Add an ellipse">
            <Circle size={14} /> Circle
          </button>
          <button className="btn" onClick={() => p.onAdd('line')} data-testid="add-line" title="Add a line">
            <Minus size={14} /> Line
          </button>
          <button className="btn" onClick={() => p.onAdd('arrow')} data-testid="add-arrow" title="Add an arrow">
            <ArrowRight size={14} /> Arrow
          </button>
          <button className="btn" onClick={() => p.onAdd('image')} data-testid="add-image" title="Add the selected image from the library">
            <ImageIcon size={14} /> Image
          </button>
          <button className="btn" onClick={() => p.onAdd('music')} data-testid="add-music" title="Add the selected audio file from the library">
            <Music size={14} /> Music
          </button>
          <button className="btn" onClick={() => p.onAdd('html')} data-testid="add-html" title="Use the selected HTML animation from the library">
            <Film size={14} /> Animation
          </button>
          <button className="btn" onClick={p.onSplit} data-testid="split" title="Split the selected clip at the playhead (S)">
            <Scissors size={14} /> Split
          </button>
          <button className="btn danger ghost" onClick={p.onDelete} data-testid="delete-clip" title="Delete the selected clip (Delete)">
            Delete
          </button>
        </div>
        <div className="timeline-tools">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(draft);
              if (!Number.isFinite(n) || n < MIN_DURATION_SEC || n > MAX_DURATION_SEC) {
                setError(`Between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC} seconds.`);
                return;
              }
              if (n !== total) void p.onDuration(n);
            }}
            style={{ display: 'flex', gap: 6, alignItems: 'center' }}
          >
            <label>
              Duration
              <input
                type="number"
                min={MIN_DURATION_SEC}
                max={MAX_DURATION_SEC}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="Timeline duration in seconds"
              />
              s
            </label>
            <button className="btn" type="submit">Set</button>
          </form>
          <label>
            <button className="btn icon ghost" type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round(z / 1.25)))}>
              <ZoomOut size={16} />
            </button>
            <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Timeline zoom" />
            <button className="btn icon ghost" type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.round(z * 1.25)))}>
              <ZoomIn size={16} />
            </button>
            <button
              className="btn ghost"
              type="button"
              data-testid="timeline-fit"
              title="Zoom so that the whole timeline, including clips that run past the end, is visible"
              onClick={() => setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.floor(900 / timelineEnd))))}
            >
              Fit
            </button>
          </label>
          <button className="btn primary" onClick={p.onExport} disabled={p.exporting} data-testid="export-timeline">
            <Video size={14} /> {p.exporting ? 'Exporting…' : 'Export video'}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="tl-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      <div className="tl-wrap">
        <div className="tl-row" style={{ width: HEAD_WIDTH + laneWidth, height: RULER_HEIGHT }}>
          <div className="tl-head tl-corner">Tracks</div>
          <div
            className="tl-ruler-lane"
            ref={rulerRef}
            style={{ width: laneWidth }}
            onPointerDown={(e) => {
              seekAt(e.clientX);
              const move = (ev: PointerEvent) => seekAt(ev.clientX);
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}
            data-testid="ruler"
          >
            {ticks.map((t) => (
              <span key={t} className="tl-tick" style={{ left: t * zoom }}>
                {formatTimecode(t)}
              </span>
            ))}
            <div className="tl-playhead" style={{ left: p.playhead * zoom }} aria-label="Playhead" />
          </div>
        </div>

        {p.tracks.map((track) => {
          const Icon = TRACK_ICON[track.id] ?? Layers;
          const rows = packRows(track.clips.map((c) => ({ id: c.id, s: shown(c).start, e: shown(c).start + shown(c).duration })));
          const rowCount = Math.max(1, ...Array.from(rows.values(), (r) => r + 1));
          const height = Math.max(TRACK_HEIGHT, rowCount * ROW_H + 8);
          return (
            <div key={track.id} className="tl-row" style={{ width: HEAD_WIDTH + laneWidth, height }}>
              <div className="tl-head">
                <Icon size={15} aria-hidden="true" />
                <span>{track.name}</span>
              </div>
              <div className="tl-lane" style={{ width: laneWidth }} data-track={track.id}>
                {track.clips.map((c) => {
                  const s = shown(c);
                  const ro = c.kind === 'audio' && Boolean(c.segmentId);
                  const selected = p.selectedId === c.id;
                  const row = rows.get(c.id) ?? 0;
                  return (
                    <div
                      key={c.id}
                      className={`tl-clip kind-${c.kind}${ro ? ' readonly' : ''}${selected ? ' selected' : ''}`}
                      data-clip={c.id}
                      data-kind={c.kind}
                      data-row={row}
                      style={{ left: s.start * zoom, width: Math.max(8, s.duration * zoom), top: 4 + row * ROW_H, bottom: 'auto', height: ROW_H - 4 }}
                      title={`${clipLabel(c)} · ${formatTimecode(s.start, true)} · ${s.duration.toFixed(1)} s${ro ? ' · narration (edit in the narration editor)' : ''}`}
                      onPointerDown={(e) => begin(e, c, 'move', track.id)}
                    >
                      {!ro && <span className="tl-grip l" onPointerDown={(e) => begin(e, c, 'trim-start', track.id)} aria-hidden="true" style={{ width: EDGE_PX }} />}
                      <span className="tl-label">
                        {ro && <Lock size={10} />} {clipLabel(c)}
                      </span>
                      {!ro && <span className="tl-grip r" onPointerDown={(e) => begin(e, c, 'trim-end', track.id)} aria-hidden="true" style={{ width: EDGE_PX }} />}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {!hasClips && (
          <p className="tl-note">
            Nothing on the timeline yet. Select an HTML animation, image or audio file in the library and add it, or use Text and the shape buttons.
          </p>
        )}
      </div>
    </>
  );
}
