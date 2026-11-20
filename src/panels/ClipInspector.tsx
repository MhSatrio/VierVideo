import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Scissors, Trash2 } from 'lucide-react';
import type { ProjectAsset, TimelineClip, TimelineTrack } from '../model/types';
import { formatTimecode } from '../model/format';
import { isReadOnly } from '../../shared/timeline.mjs';

const KIND_TITLE: Record<string, string> = {
  html: 'HTML animation',
  image: 'Image layer',
  shape: 'Shape layer',
  text: 'Text layer',
  snippet: 'HTML element layer',
  audio: 'Audio clip',
};

/** The HTML of an element layer: edited here and applied to the layer; scripts and event attributes are removed. */
function SnippetEditor({ clip, onUpdate }: { clip: TimelineClip; onUpdate(patch: Partial<TimelineClip>): void }) {
  const [html, setHtml] = useState(clip.html ?? '');
  useEffect(() => setHtml(clip.html ?? ''), [clip.html]);
  const changed = html !== (clip.html ?? '');
  return (
    <div className="section">
      <span className="label">HTML</span>
      <textarea className="snippet-input" rows={8} value={html} onChange={(e) => setHtml(e.target.value)} aria-label="HTML of the element" data-testid="snippet-edit-html" />
      <div className="code-actions">
        <button className="btn ghost" data-testid="snippet-apply" disabled={!changed} onClick={() => onUpdate({ html })}>
          Apply HTML
        </button>
      </div>
      <p className="code-note">The animation itself is not changed. Scripts and event attributes are removed when the HTML is applied.</p>
    </div>
  );
}

function NumField({ label, value, step = 1, min, max, onCommit }: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onCommit(v: number): void;
}) {
  const [draft, setDraft] = useState(String(round(value)));
  useEffect(() => setDraft(String(round(value))), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n === value) return setDraft(String(round(value)));
    onCommit(n);
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </label>
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Props {
  clip: TimelineClip;
  tracks: TimelineTrack[];
  assets: ProjectAsset[];
  playhead: number;
  onUpdate(patch: Record<string, unknown>): void;
  onMoveTrack(track: string): void;
  onSplit(): void;
  onDelete(): void;
  onBack(): void;
}

export function ClipInspector({ clip, tracks, assets, playhead, onUpdate, onMoveTrack, onSplit, onDelete, onBack }: Props) {
  const asset = clip.assetId ? assets.find((a) => a.id === clip.assetId) ?? null : null;
  const [name, setName] = useState(clip.name);
  const [text, setText] = useState(clip.text ?? '');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setName(clip.name), [clip.name]);
  useEffect(() => setText(clip.text ?? ''), [clip.text]);
  const readOnly = isReadOnly(clip);
  const isLayer = clip.kind === 'image' || clip.kind === 'shape' || clip.kind === 'text' || clip.kind === 'snippet';
  const allowedTracks = clip.kind === 'audio' ? ['music'] : clip.kind === 'text' ? ['text'] : clip.kind === 'html' ? ['html'] : clip.kind === 'snippet' ? ['visual'] : ['visual', 'text'];
  const inside = playhead >= clip.start && playhead < clip.start + clip.duration;

  const commitName = (e?: FormEvent) => {
    e?.preventDefault();
    if (name.trim() !== clip.name) onUpdate({ name: name.trim() });
  };

  return (
    <>
      <div className="panel-head">
        <button className="btn icon ghost" onClick={onBack} aria-label="Back to the project" title="Back to the project">
          <ArrowLeft size={16} />
        </button>
        <h2>{KIND_TITLE[clip.kind] ?? 'Clip'}</h2>
      </div>
      <div className="panel-body">
        <div className="section">
          {readOnly ? (
            <p className="danger-note">
              Narration segment. It follows the script and is edited in the narration editor (select the script in the library).
            </p>
          ) : null}
          <form className="field" onSubmit={commitName}>
            <span>Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => commitName()} maxLength={120} aria-label="Clip name" disabled={readOnly} />
          </form>
          <dl className="kv">
            <dt>Source</dt>
            <dd>{asset ? asset.name : clip.kind === 'text' ? 'Typed text' : clip.kind === 'shape' ? clip.shape : '—'}</dd>
            <dt>Time</dt>
            <dd>
              {formatTimecode(clip.start, true)} – {formatTimecode(clip.start + clip.duration, true)} ({round(clip.duration)} s)
            </dd>
            <dt>At the playhead</dt>
            <dd>{inside ? 'visible' : 'not visible'}</dd>
          </dl>
          {!readOnly && (
            <div className="inline-form" style={{ alignItems: 'end' }}>
              <NumField label="Start (s)" value={clip.start} step={0.1} min={0} onCommit={(v) => onUpdate({ start: v })} />
              <NumField label="Duration (s)" value={clip.duration} step={0.1} min={0.1} onCommit={(v) => onUpdate({ duration: v })} />
            </div>
          )}
          {!readOnly && allowedTracks.length > 1 && (
            <label className="field">
              <span>Track</span>
              <select value={clip.track} onChange={(e) => onMoveTrack(e.target.value)} aria-label="Track">
                {allowedTracks.map((id) => (
                  <option key={id} value={id}>
                    {tracks.find((t) => t.id === id)?.name ?? id}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {isLayer && !readOnly && (
          <div className="section">
            <span className="label">Placement</span>
            <div className="form-row">
              <NumField label="X (px)" value={clip.x ?? 0} onCommit={(v) => onUpdate({ x: v })} />
              <NumField label="Y (px)" value={clip.y ?? 0} onCommit={(v) => onUpdate({ y: v })} />
              <NumField label="Width (px)" value={clip.w ?? 1} min={1} onCommit={(v) => onUpdate({ w: v })} />
              <NumField label="Height (px)" value={clip.h ?? 1} min={1} onCommit={(v) => onUpdate({ h: v })} />
              <NumField label="Rotation (°)" value={clip.rotation ?? 0} onCommit={(v) => onUpdate({ rotation: v })} />
              <NumField label="Opacity" value={clip.opacity ?? 1} step={0.05} min={0} max={1} onCommit={(v) => onUpdate({ opacity: v })} />
            </div>
            <div className="form-row">
              <NumField label="Fade in (s)" value={clip.fadeIn ?? 0} step={0.1} min={0} onCommit={(v) => onUpdate({ fadeIn: v })} />
              <NumField label="Fade out (s)" value={clip.fadeOut ?? 0} step={0.1} min={0} onCommit={(v) => onUpdate({ fadeOut: v })} />
            </div>
            <label className="field" style={{ gridTemplateColumns: 'auto 1fr', alignItems: 'center' }}>
              <input type="checkbox" checked={Boolean(clip.behind)} onChange={(e) => onUpdate({ behind: e.target.checked })} />
              <span>Behind the HTML animation</span>
            </label>
          </div>
        )}

        {clip.kind === 'snippet' && !readOnly && <SnippetEditor clip={clip} onUpdate={onUpdate} />}

        {clip.kind === 'text' && !readOnly && (
          <div className="section">
            <span className="label">Text</span>
            <label className="field">
              <span>Words</span>
              <textarea
                rows={3}
                value={text}
                maxLength={2000}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => text !== (clip.text ?? '') && onUpdate({ text })}
                aria-label="Text content"
              />
            </label>
            <div className="form-row">
              <NumField label="Size (px)" value={clip.fontSize ?? 72} min={8} max={400} onCommit={(v) => onUpdate({ fontSize: v })} />
              <label className="field">
                <span>Weight</span>
                <select value={clip.fontWeight ?? 600} onChange={(e) => onUpdate({ fontWeight: Number(e.target.value) })} aria-label="Font weight">
                  {[400, 500, 600, 700].map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Colour</span>
                <input type="color" value={clip.color ?? '#231f20'} onChange={(e) => onUpdate({ color: e.target.value })} aria-label="Text colour" />
              </label>
              <label className="field">
                <span>Align</span>
                <select value={clip.align ?? 'center'} onChange={(e) => onUpdate({ align: e.target.value })} aria-label="Text alignment">
                  <option value="left">Left</option>
                  <option value="center">Centre</option>
                  <option value="right">Right</option>
                </select>
              </label>
            </div>
          </div>
        )}

        {clip.kind === 'shape' && !readOnly && (
          <div className="section">
            <span className="label">Shape</span>
            <div className="form-row">
              <label className="field">
                <span>Kind</span>
                <select value={clip.shape ?? 'rect'} onChange={(e) => onUpdate({ shape: e.target.value })} aria-label="Shape kind">
                  <option value="rect">Rectangle</option>
                  <option value="ellipse">Ellipse</option>
                  <option value="line">Line</option>
                  <option value="arrow">Arrow</option>
                </select>
              </label>
              <label className="field">
                <span>Fill</span>
                <input type="color" value={clip.fill ?? '#caebfb'} onChange={(e) => onUpdate({ fill: e.target.value })} aria-label="Fill colour" />
              </label>
              <label className="field">
                <span>Stroke</span>
                <input type="color" value={clip.stroke ?? '#4570b6'} onChange={(e) => onUpdate({ stroke: e.target.value })} aria-label="Stroke colour" />
              </label>
              <NumField label="Stroke width" value={clip.strokeWidth ?? 4} min={0} max={200} onCommit={(v) => onUpdate({ strokeWidth: v })} />
            </div>
          </div>
        )}

        {clip.kind === 'audio' && !readOnly && (
          <div className="section">
            <span className="label">Sound</span>
            <label className="field">
              <span>Volume {Math.round((clip.volume ?? 1) * 100)}%</span>
              <input type="range" min={0} max={2} step={0.05} value={clip.volume ?? 1} onChange={(e) => onUpdate({ volume: Number(e.target.value) })} aria-label="Volume" />
            </label>
            <div className="form-row">
              <NumField label="Fade in (s)" value={clip.fadeIn ?? 0} step={0.1} min={0} onCommit={(v) => onUpdate({ fadeIn: v })} />
              <NumField label="Fade out (s)" value={clip.fadeOut ?? 0} step={0.1} min={0} onCommit={(v) => onUpdate({ fadeOut: v })} />
            </div>
            <p className="danger-note">Volume and fades are applied in the final mix (next step).</p>
          </div>
        )}

        {clip.kind === 'html' && (
          <div className="section">
            <p className="danger-note">
              The base of the picture. It plays from this clip's start, and its animation starts at {round(clip.offset ?? 0)} s.
              One animation per project.
            </p>
          </div>
        )}

        {!readOnly && (
          <div className="section">
            <button className="btn" onClick={onSplit} data-testid="inspector-split">
              <Scissors size={14} /> Split at playhead ({formatTimecode(playhead, true)})
            </button>
            <button
              className={confirm ? 'btn danger' : 'btn danger ghost'}
              onClick={() => {
                if (!confirm) return setConfirm(true);
                onDelete();
              }}
              onBlur={() => setConfirm(false)}
              data-testid="inspector-delete"
            >
              <Trash2 size={14} /> {confirm ? 'Click again to delete' : 'Delete clip'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
