import { useState, type FormEvent } from 'react';
import { ArrowLeft, FolderOpen, Trash2, Video, X } from 'lucide-react';
import type { AspectId, FfmpegInfo, NarrationProgress, ProjectAsset, ProjectSettings, ProjectState, RenderMode, RenderOptions, TtsStatus, Voice } from '../model/types';
import { NarrationSummary, ScriptNarration, type NarrationActions } from './NarrationPanel';
import { formatBytes, formatDateTime, formatTimeOnly, shortHash } from '../model/format';
import { ASPECTS, DEFAULT_HIDE_SELECTORS, KIND_LABEL, aspectById } from '../../shared/project-format.mjs';

export interface NarrationContext {
  voices: Voice[];
  speedRange: [number, number];
  tts: TtsStatus | null | undefined;
  progress: NarrationProgress | null;
  actions: NarrationActions;
}

export interface ExportState {
  assetId: string;
  id: number | null; // known after the first progress event
  frame: number;
  total: number;
  percent: number;
}

interface Props {
  project: ProjectState;
  asset: ProjectAsset | null;
  exporting: ExportState | null;
  ffmpeg: FfmpegInfo | null | undefined;
  onClearSelection(): void;
  onUpdateSettings(patch: Partial<ProjectSettings>): Promise<unknown>;
  onRenameProject(name: string): Promise<unknown>;
  onRenameAsset(id: string, name: string): Promise<unknown>;
  onMoveAsset(id: string, folderId: string | null): Promise<unknown>;
  onRemoveAsset(id: string): Promise<unknown>;
  onSetRenderOptions(id: string, opts: Partial<RenderOptions>): Promise<unknown>;
  onExport(assetId: string): void;
  onCancelExport(id: number): void;
  onChooseFfmpeg(): void;
  onRevealRender(file: string): void;
  onReveal(): void;
  narration: NarrationContext;
}

function RenderSection(p: Props & { asset: ProjectAsset }) {
  const a = p.asset;
  const opts: RenderOptions = a.render ?? { mode: 'deterministic', hideSelectors: DEFAULT_HIDE_SELECTORS };
  const [hide, setHide] = useState(opts.hideSelectors);
  const doc = p.project.doc;
  const exporting = p.exporting?.assetId === a.id ? p.exporting : null;
  const otherExport = p.exporting !== null && !exporting;
  const aspect = aspectById(doc.settings.aspect);
  const renders = doc.renders.filter((r) => r.assetId === a.id).slice().reverse();

  const setMode = (mode: RenderMode) => p.onSetRenderOptions(a.id, { mode });
  const commitHide = () => {
    if (hide.trim() !== opts.hideSelectors) void p.onSetRenderOptions(a.id, { hideSelectors: hide.trim() });
  };

  return (
    <div className="section">
      <span className="label">Render to video</span>
      <div className="field">
        <span>Capture mode</span>
        <div className="seg" role="group" aria-label="Capture mode">
          <button aria-pressed={opts.mode === 'deterministic'} onClick={() => setMode('deterministic')}>
            Frame by frame
          </button>
          <button aria-pressed={opts.mode === 'realtime'} onClick={() => setMode('realtime')}>
            Real time
          </button>
        </div>
        <p className="danger-note">
          {opts.mode === 'deterministic'
            ? 'Recommended. Every frame is drawn at its exact time, so the export is repeatable.'
            : 'Fallback for animations that cannot be driven frame by frame. If frames are slow, the video runs late.'}
        </p>
      </div>
      <label className="field">
        <span>Hide page elements (CSS selectors)</span>
        <input
          type="text"
          value={hide}
          onChange={(e) => setHide(e.target.value)}
          onBlur={commitHide}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitHide();
          }}
          maxLength={300}
          aria-label="Hide page elements"
        />
      </label>
      <p className="danger-note">
        Exports {doc.settings.durationSec} s at {doc.settings.fps} fps, {aspect ? `${aspect.width} × ${aspect.height}` : ''}, from the project settings.
      </p>

      {p.ffmpeg === undefined ? (
        <p className="danger-note">Checking FFmpeg…</p>
      ) : p.ffmpeg ? (
        <p className="danger-note">
          FFmpeg {p.ffmpeg.version.replace(/^ffmpeg version /, '').split(' ')[0]} ({p.ffmpeg.source}).{' '}
          <button className="btn ghost" onClick={p.onChooseFfmpeg} style={{ height: 26, padding: '0 8px' }}>Change…</button>
        </p>
      ) : (
        <p className="preview-warning">
          FFmpeg was not found. Install it, or point to ffmpeg.exe.{' '}
          <button className="btn" onClick={p.onChooseFfmpeg} style={{ height: 26 }}>Choose FFmpeg…</button>
        </p>
      )}

      {exporting ? (
        <div className="export-progress" aria-live="polite">
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={exporting.percent}>
            <div style={{ width: `${exporting.percent}%` }} />
          </div>
          <div className="export-row">
            <span>
              {exporting.total ? `${exporting.percent}% · frame ${exporting.frame} of ${exporting.total}` : 'Starting…'}
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            <button
              className="btn danger"
              disabled={exporting.id === null}
              onClick={() => exporting.id !== null && p.onCancelExport(exporting.id)}
            >
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="btn primary"
          onClick={() => p.onExport(a.id)}
          disabled={!p.ffmpeg || otherExport}
          title={otherExport ? 'Another export is running' : undefined}
        >
          <Video size={16} /> Export MP4
        </button>
      )}

      {renders.length > 0 && (
        <div className="renders">
          <span className="label">Exports</span>
          <ul>
            {renders.map((r) => (
              <li key={r.id}>
                <span>
                  {r.file.replace(/^renders\//, '')}
                  <span className="meta-line">
                    {r.fps} fps · {r.durationSec} s · {formatBytes(r.bytes)} · {formatTimeOnly(r.createdAt)}
                  </span>
                </span>
                <button className="btn icon ghost" aria-label={`Show ${r.file} in folder`} title="Show in folder" onClick={() => p.onRevealRender(r.file)}>
                  <FolderOpen size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AssetDetails(p: Props & { asset: ProjectAsset }) {
  const a = p.asset;
  const [name, setName] = useState(a.name);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const folderName = a.folderId ? p.project.doc.folders.find((f) => f.id === a.folderId)?.name ?? 'Unfiled' : 'Unfiled';

  const commitName = async () => {
    const next = name.trim();
    if (!next) {
      setName(a.name);
      return;
    }
    if (next !== a.name) await p.onRenameAsset(a.id, next);
  };

  return (
    <>
      <div className="panel-head">
        <button className="btn icon ghost" onClick={p.onClearSelection} aria-label="Back to project settings" title="Back to project settings">
          <ArrowLeft size={16} />
        </button>
        <h2>Asset</h2>
      </div>
      <div className="panel-body">
        <div className="section">
          <form
            className="field"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void commitName();
            }}
          >
            <span>Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void commitName()} maxLength={120} aria-label="Asset name" />
          </form>
          <dl className="kv">
            <dt>Type</dt>
            <dd>{KIND_LABEL[a.kind]}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(a.bytes)}</dd>
            <dt>Original file</dt>
            <dd>{a.originalName}</dd>
            <dt>Added</dt>
            <dd>{formatDateTime(a.addedAt)}</dd>
            <dt>Checksum</dt>
            <dd title={a.sha256}>
              <code>{shortHash(a.sha256)}…</code>
            </dd>
            <dt>Folder</dt>
            <dd>{folderName}</dd>
          </dl>
          <label className="field">
            <span>Move to folder</span>
            <select value={a.folderId ?? ''} onChange={(e) => void p.onMoveAsset(a.id, e.target.value || null)}>
              <option value="">Unfiled</option>
              {p.project.doc.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {a.kind === 'html' && !p.project.missing.includes(a.id) && <RenderSection {...p} asset={a} />}

        {a.kind === 'script' && !p.project.missing.includes(a.id) && (
          <ScriptNarration
            project={p.project}
            asset={a}
            voices={p.narration.voices}
            speedRange={p.narration.speedRange}
            tts={p.narration.tts}
            progress={p.narration.progress}
            actions={p.narration.actions}
          />
        )}

        <div className="section">
          <button className="btn" onClick={p.onReveal}>
            <FolderOpen size={16} /> Show project folder
          </button>
          <button
            className={confirmRemove ? 'btn danger' : 'btn danger ghost'}
            onClick={async () => {
              if (!confirmRemove) return setConfirmRemove(true);
              await p.onRemoveAsset(a.id);
            }}
            onBlur={() => setConfirmRemove(false)}
          >
            <Trash2 size={16} /> {confirmRemove ? 'Click again to remove' : 'Remove from project'}
          </button>
          <p className="danger-note">Removing deletes only the copy inside the project. The original file on your computer is not touched.</p>
        </div>
      </div>
    </>
  );
}

function ProjectSettingsView(p: Props) {
  const doc = p.project.doc;
  const s = doc.settings;
  const aspect = aspectById(s.aspect);
  const totalBytes = doc.assets.reduce((sum, a) => sum + a.bytes, 0);
  const [name, setName] = useState(doc.name);

  const commitName = async () => {
    const next = name.trim();
    if (!next) {
      setName(doc.name);
      return;
    }
    if (next !== doc.name) await p.onRenameProject(next);
  };

  return (
    <>
      <div className="panel-head">
        <h2>Project</h2>
      </div>
      <div className="panel-body">
        <div className="section">
          <form
            className="field"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void commitName();
            }}
          >
            <span>Project name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void commitName()} maxLength={120} aria-label="Project name" />
          </form>

          <div className="field" role="radiogroup" aria-label="Aspect ratio">
            <span>Aspect ratio</span>
            <div className="aspect-list">
              {ASPECTS.map((a) => (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={s.aspect === a.id}
                  className="aspect-option"
                  onClick={() => void p.onUpdateSettings({ aspect: a.id as AspectId })}
                >
                  <span
                    className="aspect-glyph"
                    style={{
                      width: a.width >= a.height ? 26 : Math.round((26 * a.width) / a.height),
                      height: a.height >= a.width ? 26 : Math.round((26 * a.height) / a.width),
                    }}
                  />
                  <span>
                    <strong>{a.id}</strong> · {a.width} × {a.height}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>Frame rate</span>
            <div className="seg" role="group" aria-label="Frame rate">
              {[30, 60].map((f) => (
                <button key={f} aria-pressed={s.fps === f} onClick={() => void p.onUpdateSettings({ fps: f as 30 | 60 })}>
                  {f} fps
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="section">
          <dl className="kv">
            <dt>Output size</dt>
            <dd>{aspect ? `${aspect.width} × ${aspect.height} px` : '—'}</dd>
            <dt>Duration</dt>
            <dd>{s.durationSec} s (set in the timeline)</dd>
            <dt>Assets</dt>
            <dd>
              {doc.assets.length} · {formatBytes(totalBytes)}
            </dd>
            <dt>Exports</dt>
            <dd>{doc.renders.length}</dd>
            <dt>Created</dt>
            <dd>{formatDateTime(doc.createdAt)}</dd>
            <dt>Location</dt>
            <dd style={{ fontSize: 12 }}>{p.project.dir}</dd>
          </dl>
          <button className="btn" onClick={p.onReveal}>
            <FolderOpen size={16} /> Show project folder
          </button>
          <p className="danger-note">Select an asset in the library to see its details.</p>
        </div>

        <div className="section">
          <NarrationSummary project={p.project} progress={p.narration.progress} actions={p.narration.actions} tts={p.narration.tts} />
        </div>
      </div>
    </>
  );
}

export function InspectorPanel(p: Props) {
  if (p.asset) return <AssetDetails key={p.asset.id} {...p} asset={p.asset} />;
  return <ProjectSettingsView {...p} />;
}
