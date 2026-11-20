import { useEffect, useMemo, useState } from 'react';
import { Mic, Play, RefreshCw, Square, X } from 'lucide-react';
import type { NarrationProgress, NarrationSegment, ProjectAsset, ProjectState, TtsStatus, Voice } from '../model/types';
import { formatTimecode, projectFileUrl } from '../model/format';
import { buildSegments, parseScript, timingWarnings } from '../../shared/narration.mjs';

export interface NarrationActions {
  create(p: { sourceAssetId: string; voice: string; speed: number; segments: NarrationSegment[] }): Promise<unknown>;
  settings(p: { voice?: string; speed?: number }): Promise<unknown>;
  edit(id: string, text: string): Promise<unknown>;
  clear(): Promise<unknown>;
  generate(ids?: string[]): Promise<unknown>;
  cancel(): void;
  preview(voice: string, speed: number): Promise<string | undefined>;
  chooseTts(): void;
}

interface Common {
  project: ProjectState;
  voices: Voice[];
  speedRange: [number, number];
  tts: TtsStatus | null | undefined;
  progress: NarrationProgress | null;
  actions: NarrationActions;
}

const STATUS_LABEL = { pending: 'Not generated', ok: 'Ready', stale: 'Changed: regenerate', error: 'Failed' } as const;

function voiceLabel(voices: Voice[], id: string): string {
  const v = voices.find((x) => x.id === id);
  return v ? `${v.label} (${v.accent}, ${v.gender})` : id;
}

function TtsNotice({ tts, onChoose }: { tts: TtsStatus | null | undefined; onChoose(): void }) {
  if (tts === undefined) return <p className="danger-note">Checking the narration engine…</p>;
  if (!tts || !tts.python) {
    return (
      <p className="preview-warning">
        The narration engine (Python with Kokoro) was not found. Install it with setup-narration.ps1 (in the tts folder of the program), set VIERVIDEO_PYTHON, or choose its python.exe.{' '}
        <button className="btn" onClick={onChoose} style={{ height: 26 }}>Choose Python…</button>
      </p>
    );
  }
  return (
    <p className="danger-note">
      Narration engine: Python {tts.python.version} ({tts.python.source}).{' '}
      <button className="btn ghost" onClick={onChoose} style={{ height: 26, padding: '0 8px' }}>Change…</button>
    </p>
  );
}

function VoiceAndSpeed({ voices, speedRange, voice, speed, onVoice, onSpeed, onPreview }: {
  voices: Voice[];
  speedRange: [number, number];
  voice: string;
  speed: number;
  onVoice(v: string): void;
  onSpeed(s: number): void;
  onPreview(): void;
}) {
  return (
    <>
      <label className="field">
        <span>Voice</span>
        <div className="inline-form">
          <select value={voice} onChange={(e) => onVoice(e.target.value)} aria-label="Voice">
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label} · {v.accent} · {v.gender}
              </option>
            ))}
          </select>
          <button className="btn" type="button" onClick={onPreview}>
            <Play size={14} /> Preview
          </button>
        </div>
      </label>
      <label className="field">
        <span>Speed {speed.toFixed(2)}×</span>
        <input
          type="range"
          min={speedRange[0]}
          max={speedRange[1]}
          step={0.05}
          value={speed}
          onChange={(e) => onSpeed(Number(e.target.value))}
          aria-label="Speed"
        />
      </label>
    </>
  );
}

function SegmentRow({ seg, busy, onEdit, onRegenerate, onPlay }: {
  seg: NarrationSegment;
  busy: boolean;
  onEdit(text: string): void;
  onRegenerate(): void;
  onPlay(rel: string): void;
}) {
  const [text, setText] = useState(seg.text);
  useEffect(() => setText(seg.text), [seg.text]);
  const time = seg.start !== null
    ? `${formatTimecode(seg.start, true)}${seg.end !== null ? ' – ' + formatTimecode(seg.end, true) : ''}`
    : 'after the previous';
  return (
    <li className={`seg-row seg-${seg.status}`} data-testid="segment">
      <div className="seg-head">
        <strong>#{seg.index}</strong>
        <span className="meta-line">{time}</span>
        <span className={`badge${seg.status === 'ok' ? '' : ' warn'}`}>{STATUS_LABEL[seg.status]}</span>
        {seg.durationSec !== null && <span className="meta-line">{seg.durationSec.toFixed(1)} s</span>}
      </div>
      <textarea
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() && text !== seg.text) onEdit(text.trim());
          else setText(seg.text);
        }}
        aria-label={`Text of segment ${seg.index}`}
        maxLength={2000}
      />
      <div className="seg-actions">
        {seg.file && (
          <button className="btn icon ghost" aria-label={`Play segment ${seg.index}`} title="Play" onClick={() => onPlay(seg.file!)}>
            <Play size={14} />
          </button>
        )}
        <button className="btn" onClick={onRegenerate} disabled={busy} aria-label={`Regenerate segment ${seg.index}`}>
          <RefreshCw size={14} /> Regenerate
        </button>
        {seg.error && <span className="danger-note" title={seg.error}>{seg.error.slice(0, 120)}</span>}
      </div>
      {seg.file && <audio controls preload="none" src={projectFileUrl(seg.file)} aria-label={`Audio of segment ${seg.index}`} />}
    </li>
  );
}

/** The narration editor for the script asset that is the narration source. */
function NarrationEditor({ project, asset, voices, speedRange, tts, progress, actions }: Common & { asset: ProjectAsset }) {
  const nar = project.doc.narration!;
  const [voice, setVoice] = useState(nar.voice);
  const [speed, setSpeed] = useState(nar.speed);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => setVoice(nar.voice), [nar.voice]);
  useEffect(() => setSpeed(nar.speed), [nar.speed]);

  const missing = nar.segments.filter((s) => s.status !== 'ok');
  const generating = progress !== null;
  const warnings = timingWarnings(nar.segments);
  const ready = nar.segments.filter((s) => s.status === 'ok').length;

  return (
    <div className="section">
      <span className="label">Narration from “{asset.name}”</span>
      <TtsNotice tts={tts} onChoose={actions.chooseTts} />
      <VoiceAndSpeed
        voices={voices}
        speedRange={speedRange}
        voice={voice}
        speed={speed}
        onVoice={(v) => {
          setVoice(v);
          void actions.settings({ voice: v });
        }}
        onSpeed={(s) => {
          setSpeed(s);
          void actions.settings({ speed: s });
        }}
        onPreview={() => void actions.preview(voice, speed).then((f) => f && setPreviewFile(f))}
      />
      {previewFile && (
        <audio controls autoPlay src={projectFileUrl(previewFile)} aria-label="Voice preview" />
      )}
      <p className="danger-note">
        {ready} of {nar.segments.length} segments ready · {voiceLabel(voices, nar.voice)}
      </p>

      {generating ? (
        <div className="export-progress" aria-live="polite">
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress!.done / Math.max(1, progress!.total)) * 100)}>
            <div style={{ width: `${Math.round((progress!.done / Math.max(1, progress!.total)) * 100)}%` }} />
          </div>
          <div className="export-row">
            <span>Generating {progress!.done} of {progress!.total}</span>
            <span style={{ flex: 1 }} />
            <button className="btn danger" onClick={actions.cancel}>
              <Square size={12} /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="btn primary"
          onClick={() => void actions.generate()}
          disabled={missing.length === 0 || !tts?.python}
        >
          <Mic size={16} /> Generate {missing.length ? `${missing.length} missing` : 'all'}
        </button>
      )}

      {warnings.length > 0 && (
        <ul className="timing-warnings">
          {warnings.map((w) => (
            <li key={w.id + w.message}>{w.message}</li>
          ))}
        </ul>
      )}

      <ol className="seg-list">
        {nar.segments.map((seg) => (
          <SegmentRow
            key={seg.id}
            seg={seg}
            busy={generating}
            onEdit={(text) => void actions.edit(seg.id, text)}
            onRegenerate={() => void actions.generate([seg.id])}
            onPlay={(rel) => setPreviewFile(rel)}
          />
        ))}
      </ol>

      <button
        className={confirmClear ? 'btn danger' : 'btn danger ghost'}
        onClick={() => {
          if (!confirmClear) return setConfirmClear(true);
          void actions.clear();
        }}
        onBlur={() => setConfirmClear(false)}
      >
        <X size={14} /> {confirmClear ? 'Click again to remove the narration' : 'Remove narration'}
      </button>
      <p className="danger-note">Removes the segments and their audio from the project. The script file stays in the library.</p>
    </div>
  );
}

/** Shown for a script that is not the narration source yet. Parses it first so the user sees the result. */
function NarrationCreate({ asset, voices, speedRange, tts, actions }: Common & { asset: ProjectAsset }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState('af_heart');
  const [speed, setSpeed] = useState(1);
  const [previewFile, setPreviewFile] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    window.vv
      .readText(asset.id)
      .then((t) => !cancelled && setText(t))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [asset.id]);

  const parsed = useMemo(() => (text === null ? null : parseScript(text, asset.ext)), [text, asset.ext]);
  const segments = useMemo(() => (parsed ? buildSegments(parsed) : []), [parsed]);

  return (
    <div className="section">
      <span className="label">Create narration from this script</span>
      <TtsNotice tts={tts} onChoose={actions.chooseTts} />
      {error && <p className="preview-warning">{error}</p>}
      {parsed && (
        <p className="danger-note">
          Format: {parsed.format}. {segments.length} segment{segments.length === 1 ? '' : 's'}.
          {parsed.warnings.length > 0 && ` ${parsed.warnings.slice(0, 3).join(' ')}`}
        </p>
      )}
      <VoiceAndSpeed
        voices={voices}
        speedRange={speedRange}
        voice={voice}
        speed={speed}
        onVoice={setVoice}
        onSpeed={setSpeed}
        onPreview={() => void actions.preview(voice, speed).then((f) => f && setPreviewFile(f))}
      />
      {previewFile && <audio controls autoPlay src={projectFileUrl(previewFile)} aria-label="Voice preview" />}
      <button
        className="btn primary"
        disabled={!segments.length}
        onClick={() =>
          void actions.create({ sourceAssetId: asset.id, voice, speed, segments })
        }
      >
        <Mic size={16} /> Create {segments.length} segment{segments.length === 1 ? '' : 's'}
      </button>
      <p className="danger-note">Timed scripts (SRT, VTT, [0:05 - 0:12] lines, JSON, CSV) keep their times. Plain text is split into sentences.</p>
    </div>
  );
}

/** Narration for the selected script asset (create or edit), or a summary for the project. */
export function ScriptNarration(p: Common & { asset: ProjectAsset }) {
  const nar = p.project.doc.narration;
  if (nar && nar.sourceAssetId === p.asset.id) return <NarrationEditor {...p} />;
  return <NarrationCreate {...p} />;
}

export function NarrationSummary({ project, progress, actions, tts }: Pick<Common, 'project' | 'progress' | 'actions' | 'tts'>) {
  const nar = project.doc.narration;
  if (!nar) return null;
  const ready = nar.segments.filter((s) => s.status === 'ok').length;
  const missing = nar.segments.length - ready;
  return (
    <div className="section">
      <span className="label">Narration</span>
      <p className="danger-note">
        {nar.segments.length} segment{nar.segments.length === 1 ? '' : 's'} · {ready} ready · voice {nar.voice} · speed {nar.speed.toFixed(2)}×
      </p>
      {progress ? (
        <p className="danger-note">Generating {progress.done} of {progress.total}…</p>
      ) : missing > 0 ? (
        <button className="btn" onClick={() => void actions.generate()} disabled={!tts?.python}>
          <Mic size={14} /> Generate {missing} missing
        </button>
      ) : null}
    </div>
  );
}
