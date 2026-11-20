import { useEffect, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Code, Copy, Group, RotateCcw, Trash2, Ungroup, X } from 'lucide-react';
import type { ElementInfo, PartKey, PartRecord, ProjectAsset, ProjectState } from '../model/types';
import { findClip, layerStates, sanitizeSnippet } from '../../shared/timeline.mjs';
import { CompositionPreview, type Box, type GridSettings, type Items } from './CompositionPreview';
import type { AddKind } from './TimelinePanel';
import { aspectById } from '../../shared/project-format.mjs';

/**
 * The offset of an element or a part of the canvas, if it has been moved at this time (for the studio's panel). A part's
 * move applies in the stretch of the video where it is the same part, so only that stretch counts.
 */
function movedOf(info: ElementInfo, asset: ProjectAsset, playhead: number): { selector: string; x: number; y: number } | null {
  if (info.op) {
    const hit = (asset.render?.opOffsets ?? []).find(
      (o) => o.index === info.op!.index && o.key === info.op!.key && playhead >= o.t0 - 1e-6 && playhead <= o.t1 + 1e-6,
    );
    return hit ? { selector: info.selector, x: hit.dx, y: hit.dy } : null;
  }
  const hit = (asset.render?.elementOffsets ?? []).find((o) => o.selector === info.selector && o.tag === info.tag.toLowerCase() && o.id === (info.id || ''));
  return hit ? { selector: hit.selector, x: hit.x, y: hit.y } : null;
}

/** What a part of the canvas is, in words: its kind and its text or colour. */
function partName(op: NonNullable<ElementInfo['op']>): string {
  if (op.kind === 'text') return `Text “${op.text}”`;
  if (op.kind === 'stroke') return `Line ${op.color}`;
  if (op.kind === 'fill') return `Filled shape ${op.color}`;
  if (op.kind === 'image') return 'Image';
  return 'Box';
}

/**
 * True when an element covers (almost) the whole frame: in the FTIR animation that is its canvas, on which the circles,
 * lines and letters are painted as pixels. Such an element cannot be moved part by part, so it is not moved.
 */
export function coversFrame(info: Pick<ElementInfo, 'rect'>, project: ProjectState): boolean {
  const frame = aspectById(project.doc.settings.aspect);
  if (!frame) return false;
  return info.rect.w >= frame.width * 0.9 && info.rect.h >= frame.height * 0.9;
}

const TOOLS: Array<{ kind: AddKind; label: string; title: string }> = [
  { kind: 'text', label: 'Text', title: 'Add a text layer at the playhead' },
  { kind: 'rect', label: 'Box', title: 'Add a box at the playhead' },
  { kind: 'ellipse', label: 'Circle', title: 'Add a circle at the playhead' },
  { kind: 'line', label: 'Line', title: 'Add a line at the playhead' },
  { kind: 'arrow', label: 'Arrow', title: 'Add an arrow at the playhead' },
  { kind: 'image', label: 'Image', title: 'Add the selected image or SVG from the library' },
];

interface Props {
  project: ProjectState;
  playhead: number;
  onSeek(sec: number): void;
  /** The selected layers and canvas parts. A group is always selected whole. */
  selectedIds: string[];
  selectedParts: PartKey[];
  onSelect(layers: string[], parts: PartKey[]): void;
  /** Moves the selected items (a group moves as one) by an offset in frame pixels. */
  onMoveItems(items: Items, dx: number, dy: number): void;
  /** Resizes the selected items from the selection box `from` to the box `to` (frame pixels). */
  onScaleItems(items: Items, from: Box, to: Box): void;
  /** A click on a layer in the list: the layer with its group (shift-click adds or removes the group). */
  onPickLayer(id: string, additive: boolean): void;
  /** Groups the selected layers (two or more), or takes the selected layers out of their groups. */
  onGroup(): void;
  onUngroup(): void;
  /** Adds an HTML element (as text) as a layer at the playhead. */
  onImportSnippet(html: string, name: string): void;
  onAdd(kind: AddKind): void;
  onDelete(): void;
  inspected: ElementInfo | null;
  /** Finds the element of the animation under a point (frame pixels) and returns it. */
  onInspect(pt: { x: number; y: number }): Promise<ElementInfo | null>;
  /** Moves an element of the animation by an offset (frame pixels); the move is saved in the project. */
  onElementMove(info: ElementInfo, dx: number, dy: number): void;
  /** Puts an element back where the animation puts it. */
  onResetElement(selector: string): void;
  /** The paint calls of the animation at the playhead (the parts that can be picked). */
  parts: PartRecord[];
  /** A click on a part in the list: the part with its group (shift-click adds or removes it). */
  onSelectPart(part: PartRecord, additive: boolean): void;
  /** Moves a layer one step up ('forward', drawn above) or down ('backward') in its track. */
  onReorder(id: string, direction: 'forward' | 'backward'): void;
  /** The HTML animation (its code is shown for the selected element). */
  htmlAsset: ProjectAsset | null;
  /** The inspector for the selected layer (shown instead of the element panel while one layer is selected). */
  clipInspector: ReactNode | null;
  onShowCode(): void;
  onClose(): void;
}

/**
 * The studio: a large, zoomable view of the animation with its layers. Click a layer to select it (a group is selected
 * whole); drag on empty space to select several. Drag a layer to move it, and a corner handle to resize it. Click an
 * element of the animation to see its code, and drag it to move it (saved in the project). Add boxes, circles, text,
 * images and HTML elements as in a drawing tool. Timing stays on the timeline; close the studio to change it.
 */
export function Studio(p: Props) {
  const [grid, setGrid] = useState<GridSettings>({ show: false, snap: true, size: 50 });
  const [snippetOpen, setSnippetOpen] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g' && !snippetOpen) {
        e.preventDefault();
        if (e.shiftKey) p.onUngroup();
        else p.onGroup();
        return;
      }
      // Escape closes the innermost thing: the element dialog, then a menu, then the studio.
      if (e.key !== 'Escape') return;
      if (snippetOpen) setSnippetOpen(false);
      else if (!document.querySelector('.ctx-menu')) p.onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [p.onClose, p.onGroup, p.onUngroup, snippetOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="studio" role="dialog" aria-modal="true" aria-label="Studio" data-testid="studio">
      <header className="studio-bar">
        <strong>Studio</strong>
        <span className="count">{p.project.doc.name}</span>
        <div className="studio-tools" role="toolbar" aria-label="Add to the animation">
          {TOOLS.map((t) => (
            <button key={t.kind} className="btn ghost" data-testid={`studio-add-${t.kind}`} title={t.title} onClick={() => p.onAdd(t.kind)}>
              {t.label}
            </button>
          ))}
          <button className="btn ghost" data-testid="studio-add-element" title="Add an HTML element as a layer (paste its HTML or choose a file)" onClick={() => setSnippetOpen(true)}>
            Element
          </button>
          {p.selectedIds.length > 0 && (
            <button className="btn ghost" data-testid="studio-delete" onClick={p.onDelete} title="Delete the selected layers">
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
        <span className="spacer" />
        <label className="grid-control">
          <input type="checkbox" checked={grid.show} onChange={(e) => setGrid({ ...grid, show: e.target.checked })} data-testid="grid-show" /> Ruler and grid
        </label>
        <label className="grid-control">
          <input type="checkbox" checked={grid.snap} onChange={(e) => setGrid({ ...grid, snap: e.target.checked })} data-testid="grid-snap" /> Snap
        </label>
        <select value={grid.size} onChange={(e) => setGrid({ ...grid, size: Number(e.target.value) })} aria-label="Grid size" data-testid="grid-size">
          {[10, 25, 50, 100].map((n) => (
            <option key={n} value={n}>{n} px</option>
          ))}
        </select>
        <button className="btn ghost" data-testid="studio-code" onClick={p.onShowCode} title="Show the HTML code of the animation">
          <Code size={14} /> Code
        </button>
        <button className="btn primary" data-testid="studio-close" onClick={p.onClose} title="Close the studio (Escape)">
          <X size={14} /> Close studio
        </button>
      </header>
      <div className="studio-body">
        <div className="studio-canvas">
          <CompositionPreview
            project={p.project}
            playhead={p.playhead}
            onSeek={p.onSeek}
            selectedIds={p.selectedIds}
            selectedParts={p.selectedParts}
            parts={p.parts}
            onSelect={p.onSelect}
            onMoveItems={p.onMoveItems}
            onScaleItems={p.onScaleItems}
            onInspect={p.onInspect}
            onElementMove={p.onElementMove}
            grid={grid}
          />
        </div>
        <aside className="studio-side" data-testid="studio-side">
          <LayerList
            project={p.project}
            playhead={p.playhead}
            selectedIds={p.selectedIds}
            selectedParts={p.selectedParts}
            parts={p.parts}
            onPick={p.onPickLayer}
            onSelectPart={p.onSelectPart}
            onReorder={p.onReorder}
          />
          {p.selectedIds.length + p.selectedParts.length > 1 ? (
            <SelectionPanel
              count={p.selectedIds.length + p.selectedParts.length}
              grouped={isGrouped(p.project, p.selectedIds, p.selectedParts)}
              onGroup={p.onGroup}
              onUngroup={p.onUngroup}
            />
          ) : p.selectedIds.length === 1 && p.selectedParts.length === 0 && p.clipInspector ? (
            p.clipInspector
          ) : (
            <ElementPanel
              info={p.inspected}
              wholeFrame={p.inspected ? coversFrame(p.inspected, p.project) : false}
              htmlAsset={p.htmlAsset}
              moved={p.inspected && p.htmlAsset ? movedOf(p.inspected, p.htmlAsset, p.playhead) : null}
              onReset={p.onResetElement}
              onShowCode={p.onShowCode}
            />
          )}
        </aside>
      </div>
      {snippetOpen && (
        <SnippetDialog
          onAdd={(html, name) => {
            setSnippetOpen(false);
            p.onImportSnippet(html, name);
          }}
          onClose={() => setSnippetOpen(false)}
        />
      )}
    </div>
  );
}

/** True when a selected layer or canvas part is in a group (so Ungroup has something to take apart). */
function isGrouped(project: ProjectState, selectedIds: string[], selectedParts: PartKey[]): boolean {
  const tracks = project.doc.timeline.tracks;
  const layerGrouped = selectedIds.some((id) => Boolean(findClip(tracks, id)?.group));
  const asset = tracks.flatMap((t) => t.clips).find((c) => c.kind === 'html');
  const groups = project.doc.assets.find((a) => a.id === asset?.assetId)?.render?.partGroups ?? [];
  const partGrouped = selectedParts.some((p) => groups.some((g) => g.index === p.index && g.key === p.key));
  return layerGrouped || partGrouped;
}

/** The panel for two or more selected layers and canvas parts: they move and resize together; a group keeps them together. */
function SelectionPanel({ count, grouped, onGroup, onUngroup }: { count: number; grouped: boolean; onGroup(): void; onUngroup(): void }) {
  return (
    <div className="element-info selection-info" data-testid="selection-info">
      <h3>{count} selected</h3>
      <p className="code-note">
        Drag one of them to move all of them. Drag a corner handle to resize them together. Group them (Ctrl+G) so that a click
        selects them as one.
      </p>
      <div className="code-actions">
        <button className="btn ghost" data-testid="group-selection" onClick={onGroup} disabled={count < 2} title="Group the selected layers and parts (Ctrl+G)">
          <Group size={14} /> Group
        </button>
        <button className="btn ghost" data-testid="ungroup-selection" onClick={onUngroup} disabled={!grouped} title="Take the selected layers out of their group (Ctrl+Shift+G)">
          <Ungroup size={14} /> Ungroup
        </button>
      </div>
    </div>
  );
}

/**
 * Adds an HTML element as a layer. The element is drawn on its own: the animation's HTML and code are not changed. Scripts
 * and event attributes are removed (they are not needed to draw an element).
 */
function SnippetDialog({ onAdd, onClose }: { onAdd(html: string, name: string): void; onClose(): void }) {
  const [html, setHtml] = useState('');
  const [name, setName] = useState('HTML element');
  const removed = html.length > 0 && sanitizeSnippet(html) !== html;
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setHtml(await file.text());
    setName(file.name.replace(/\.[^.]+$/, '') || 'HTML element');
  };
  return (
    <div className="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog snippet-dialog" role="dialog" aria-modal="true" aria-labelledby="snippet-title" data-testid="snippet-dialog">
        <div className="dialog-head">
          <h2 id="snippet-title">Add an HTML element</h2>
        </div>
        <p className="code-note">
          Paste the HTML of one element (a div, a span, an svg), or choose a file with it. It becomes a layer at the playhead.
          The animation itself is not changed.
        </p>
        <label className="field">
          <span>HTML of the element</span>
          <textarea
            className="snippet-input"
            rows={9}
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            placeholder={'<div style="width:100%;height:100%;background:#caebfb"></div>'}
            aria-label="HTML of the element"
            data-testid="snippet-html"
          />
        </label>
        <div className="form-row">
          <label className="field">
            <span>Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Element name" data-testid="snippet-name" />
          </label>
          <label className="field">
            <span>Or choose a file</span>
            <input type="file" accept=".html,.htm,.svg,.txt" onChange={(e) => void readFile(e.target.files?.[0])} aria-label="HTML file" data-testid="snippet-file" />
          </label>
        </div>
        {removed && (
          <p className="code-note" data-testid="snippet-removed">
            Scripts and event attributes are removed when the element is added.
          </p>
        )}
        <p className="code-note">
          The element is drawn as it is written, with its own styles. Animations inside it run in real time, not on the timeline
          clock, so keep the element still.
        </p>
        <div className="dialog-foot">
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" data-testid="snippet-add" disabled={!html.trim()} onClick={() => onAdd(html, name.trim() || 'HTML element')}>
            Add element
          </button>
        </div>
      </div>
    </div>
  );
}

function ElementPanel({
  info,
  wholeFrame,
  htmlAsset,
  moved,
  onReset,
  onShowCode,
}: {
  info: ElementInfo | null;
  wholeFrame: boolean;
  htmlAsset: ProjectAsset | null;
  moved: { selector: string; x: number; y: number } | null;
  onReset(selector: string): void;
  onShowCode(): void;
}) {
  if (!info) {
    return (
      <div className="studio-hint">
        <h3>Elements</h3>
        <p>Click a layer to select it. Drag on empty space to select several. Drag a corner handle to resize.</p>
        <p>Click an element of the animation to see its code. Drag it to move it. Right-click the preview for more.</p>
      </div>
    );
  }
  return (
    <div className="element-info" data-testid="element-info" data-tag={info.tag}>
      <h3>{info.op ? partName(info.op) : <>&lt;{info.tag}&gt;</>}</h3>
      {info.op && (
        <p className="code-note" data-testid="element-part">
          A part of the animation, painted on its canvas. Drag it in the preview to move it; the move is saved in this project.
        </p>
      )}
      <dl className="kv">
        {info.id && (
          <>
            <dt>id</dt>
            <dd>{info.id}</dd>
          </>
        )}
        {info.classes.length > 0 && (
          <>
            <dt>classes</dt>
            <dd>{info.classes.join(' ')}</dd>
          </>
        )}
        {info.text && (
          <>
            <dt>text</dt>
            <dd>{info.text}</dd>
          </>
        )}
        <dt>size</dt>
        <dd>
          {info.rect.w} × {info.rect.h} px at {info.rect.x}, {info.rect.y}
        </dd>
        <dt>path</dt>
        <dd>
          <code data-testid="element-selector">{info.selector}</code>
        </dd>
      </dl>
      {wholeFrame && (
        <p className="code-note" data-testid="element-whole-frame">
          This is the whole animation canvas. Its circles, lines and letters are painted on it as pixels, so they cannot be picked
          or moved one by one. It is not moved; drag on it to select layers instead.
        </p>
      )}
      {moved && (
        <p className="code-note" data-testid="element-moved">
          Moved by {moved.x} px, {moved.y} px in this project.{' '}
          <button className="btn ghost" data-testid="element-reset" onClick={() => onReset(info.selector)}>
            <RotateCcw size={12} /> Reset position
          </button>
        </p>
      )}
      {htmlAsset && !info.op && <CodeSnippet assetId={htmlAsset.id} sha={htmlAsset.sha256} info={info} />}
      <div className="code-actions">
        <button className="btn ghost" data-testid="element-copy" onClick={() => void navigator.clipboard?.writeText(info.selector)} title="Copy the path of this element">
          <Copy size={14} /> Copy path
        </button>
        <button className="btn ghost" data-testid="element-code" onClick={onShowCode}>
          <Code size={14} /> Open the full code
        </button>
      </div>
      {!wholeFrame && (
        <p className="code-note">Drag the element in the preview to move it. The move is saved in this project; the file you imported is not changed.</p>
      )}
    </div>
  );
}

/**
 * The code that makes the element, as a browser's inspector would show it: the lines around the element's id or its
 * class in the animation's code. When the script builds the element, no line names it, so its live HTML is shown.
 */
function CodeSnippet({ assetId, sha, info }: { assetId: string; sha: string; info: ElementInfo }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setText(null);
    window.vv
      .readText(assetId)
      .then((t) => alive && setText(t))
      .catch(() => alive && setText(''));
    return () => {
      alive = false;
    };
  }, [assetId, sha]);

  if (text === null) return <p className="code-note">Looking for the element in the code…</p>;
  const lines = text.split('\n');
  const at = findElementLine(lines, info);
  if (at < 0) {
    return (
      <>
        <p className="code-note" data-testid="element-source-none">
          No line of the code names this element, so the script builds it. Its HTML as it is now:
        </p>
        <pre className="snippet" data-testid="element-html">{info.html}</pre>
      </>
    );
  }
  const from = Math.max(0, at - 4);
  const to = Math.min(lines.length, at + 9);
  return (
    <pre className="snippet" data-testid="element-source">
      {lines.slice(from, to).map((line, i) => (
        <div key={from + i} className={from + i === at ? 'hit' : undefined}>
          <span className="ln">{from + i + 1}</span>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

/** The line of the code where the element's id (or, failing that, its first class) is written; -1 if none is. */
export function findElementLine(lines: string[], info: Pick<ElementInfo, 'id' | 'classes'>): number {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns: RegExp[] = [];
  if (info.id) patterns.push(new RegExp(`\\bid\\s*=\\s*["']${esc(info.id)}["']`));
  const cls = info.classes.find((c) => c.length > 1);
  if (cls) patterns.push(new RegExp(`class\\s*=\\s*["'][^"']*\\b${esc(cls)}\\b`));
  for (const re of patterns) {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * The layers drawn at this frame (top first), with bring-forward and send-backward, and the parts of the canvas. Pick a
 * row to select it (its group with it); shift-click adds it to the selection. The order of layers is their order in the
 * timeline; the parts are in the order the animation draws them.
 */
function LayerList({
  project,
  playhead,
  selectedIds,
  selectedParts,
  parts,
  onPick,
  onSelectPart,
  onReorder,
}: {
  project: ProjectState;
  playhead: number;
  selectedIds: string[];
  selectedParts: PartKey[];
  parts: PartRecord[];
  onPick(id: string, additive: boolean): void;
  onSelectPart(part: PartRecord, additive: boolean): void;
  onReorder(id: string, direction: 'forward' | 'backward'): void;
}) {
  const partGroups = project.doc.assets.find((a) => a.kind === 'html')?.render?.partGroups ?? [];
  const tracks = project.doc.timeline.tracks;
  const drawn = (layerStates(tracks, playhead).layers as Array<{ id: string; track: string; kind: string; visible: boolean }>)
    .filter((l) => l.visible)
    .reverse(); // the top layer first
  const frame = aspectById(project.doc.settings.aspect);
  // The background (a paint call that covers the frame) cannot be picked, so it is not listed.
  const pickable = parts.filter(
    (part) => part.bbox && frame && (part.bbox[2] - part.bbox[0]) * (part.bbox[3] - part.bbox[1]) < frame.width * frame.height * 0.9,
  );
  return (
    <section className="layer-list" data-testid="layer-list">
      <h3>Layers at this frame ({drawn.length})</h3>
      {drawn.length === 0 && <p className="code-note">No layer is visible at this time.</p>}
      <ul>
        {drawn.map((l) => {
          const clip = findClip(tracks, l.id);
          const label = clip
            ? clip.kind === 'text'
              ? clip.text || 'Text'
              : clip.kind === 'snippet'
                ? clip.name || 'HTML element'
                : clip.name || clip.kind
            : l.kind;
          const grouped = Boolean(clip?.group);
          return (
            <li key={l.id} className={`layer-row${selectedIds.includes(l.id) ? ' selected' : ''}`} data-testid="layer-row" data-layer={l.id}>
              <button className="layer-name" data-testid="layer-pick" onClick={(e) => onPick(l.id, e.shiftKey)}>
                {label}
                <small>
                  {l.track}
                  {grouped ? ' · grouped' : ''}
                </small>
              </button>
              <button className="btn icon ghost" aria-label="Bring forward" title="Bring forward (drawn above)" data-testid="layer-forward" onClick={() => onReorder(l.id, 'forward')}>
                <ArrowUp size={12} />
              </button>
              <button className="btn icon ghost" aria-label="Send backward" title="Send backward (drawn below)" data-testid="layer-backward" onClick={() => onReorder(l.id, 'backward')}>
                <ArrowDown size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      <h3>Parts of the animation ({pickable.length})</h3>
      {pickable.length === 0 && <p className="code-note">No part of a canvas is drawn at this time, or the animation is not drawn on a canvas.</p>}
      <ul>
        {pickable.map((part) => {
          const [x0, y0, x1, y1] = part.bbox as [number, number, number, number];
          return (
            <li
              key={part.index}
              className={`layer-row${selectedParts.some((k) => k.index === part.index && k.key === part.key) ? ' selected' : ''}`}
            >
              <button className="layer-name" data-testid="part-row" data-part={part.index} onClick={(e) => onSelectPart(part, e.shiftKey)}>
                {partName(part)}
                <small>
                  {part.kind} · {Math.round(x1 - x0)} × {Math.round(y1 - y0)} px
                  {partGroups.some((g) => g.index === part.index && g.key === part.key && playhead >= g.t0 - 1e-6 && playhead <= g.t1 + 1e-6)
                    ? ' · grouped'
                    : ''}
                </small>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
