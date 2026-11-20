import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Pause, Play, Square, StepBack, StepForward } from 'lucide-react';
import type { ProjectAsset, ProjectState } from '../model/types';
import { assetUrl, formatTimecode } from '../model/format';
import { aspectById, KIND_LABEL } from '../../shared/project-format.mjs';

interface Props {
  project: ProjectState;
  asset: ProjectAsset | null;
}

function prettyText(body: string, ext: string): string {
  if (ext !== '.json') return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/**
 * Frame-accurate preview of an HTML animation. Every frame comes from the same deterministic engine
 * as the export, so the frame shown at a time is the frame that is exported at that time.
 */
function HtmlPreview({ project, asset }: { project: ProjectState; asset: ProjectAsset }) {
  const fps = project.doc.settings.fps;
  const durationMs = project.doc.settings.durationSec * 1000;
  const frameMs = 1000 / fps;
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const tRef = useRef(0);
  const flight = useRef<Promise<void> | null>(null);
  const wanted = useRef<number | null>(null);
  const alive = useRef(true);

  // One request at a time. While a frame is being rendered, only the newest requested time is kept.
  const renderAt = useCallback(async (ms: number): Promise<void> => {
    const target = Math.max(0, Math.min(durationMs, ms));
    tRef.current = target;
    setT(target);
    wanted.current = target;
    if (flight.current) return flight.current;
    const run = async () => {
      while (alive.current && wanted.current !== null) {
        const next = wanted.current;
        wanted.current = null;
        setBusy(true);
        try {
          const r = await window.vv.renderPreview(asset.id, next);
          if (!alive.current) return;
          setFrame(`data:image/png;base64,${r.png}`);
          setError(null);
          if (r.warnings.length) setWarnings(r.warnings);
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
  }, [asset.id, durationMs]);

  // A new asset starts again at 0. Leaving the preview frees its render window.
  useEffect(() => {
    alive.current = true;
    setPlaying(false);
    setFrame(null);
    setWarnings([]);
    void renderAt(0);
    return () => {
      alive.current = false;
      void window.vv.closePreview().catch(() => undefined);
    };
  }, [asset.id, renderAt]);

  // Playback: follow the wall clock; when rendering is slower than real time, frames are skipped.
  useEffect(() => {
    if (!playing) return;
    const wall0 = performance.now();
    const t0 = tRef.current;
    let stopped = false;
    (async () => {
      while (!stopped && alive.current) {
        const target = Math.min(durationMs, t0 + (performance.now() - wall0));
        await renderAt(target);
        if (target >= durationMs) {
          setPlaying(false);
          break;
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [playing, durationMs, renderAt]);

  const frameIndex = Math.round((t * fps) / 1000);
  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (t >= durationMs) void renderAt(0);
    setPlaying(true);
  };

  return (
    <>
      <div className="frame-wrap">
        <div className="frame" style={{ '--w': aspectById(project.doc.settings.aspect)?.width ?? 1080, '--h': aspectById(project.doc.settings.aspect)?.height ?? 1920 } as CSSProperties} data-testid="composition-frame">
          {frame ? <img src={frame} alt={`${asset.name} at ${formatTimecode(t / 1000, true)}`} draggable={false} /> : null}
          {!frame && !error && (
            <div className="placeholder"><span>Rendering preview…</span></div>
          )}
          {error && (
            <div className="placeholder">
              <strong>Preview unavailable</strong>
              <span>{error}</span>
            </div>
          )}
          {busy && frame && <span className="render-dot" aria-label="Rendering" />}
        </div>
      </div>
      <div className="transport" role="group" aria-label="Playback">
        <button className="btn icon ghost" aria-label="Stop" title="Stop and return to 0:00" onClick={() => { setPlaying(false); void renderAt(0); }}>
          <Square size={14} />
        </button>
        <button className="btn icon ghost" aria-label="Previous frame" title="Previous frame" onClick={() => { setPlaying(false); void renderAt((Math.max(0, frameIndex - 1) * 1000) / fps); }}>
          <StepBack size={16} />
        </button>
        <button className="btn icon primary" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button className="btn icon ghost" aria-label="Next frame" title="Next frame" onClick={() => { setPlaying(false); void renderAt(((frameIndex + 1) * 1000) / fps); }}>
          <StepForward size={16} />
        </button>
        <input
          type="range"
          className="scrubber"
          min={0}
          max={durationMs}
          step={frameMs}
          value={t}
          aria-label="Playhead"
          onChange={(e) => {
            setPlaying(false);
            void renderAt(Number(e.target.value));
          }}
        />
        <span className="timecode">
          {formatTimecode(t / 1000, true)} / {formatTimecode(durationMs / 1000, true)} · frame {frameIndex}
        </span>
      </div>
      {warnings.length > 0 && <p className="preview-warning">{warnings.join(' ')}</p>}
    </>
  );
}

export function PreviewPanel({ project, asset }: Props) {
  const s = project.doc.settings;
  const aspect = aspectById(s.aspect);
  const width = aspect?.width ?? 1080;
  const height = aspect?.height ?? 1920;
  const isMissing = asset ? project.missing.includes(asset.id) : false;
  const isHtml = asset?.kind === 'html' && !isMissing;

  const [text, setText] = useState<{ id: string; body: string } | null>(null);
  const [textError, setTextError] = useState<string | null>(null);

  const assetId = asset?.id ?? null;
  const isScript = asset?.kind === 'script' && !isMissing;
  useEffect(() => {
    if (!assetId || !isScript) return;
    let cancelled = false;
    setTextError(null);
    window.vv
      .readText(assetId)
      .then((body) => {
        if (!cancelled) setText({ id: assetId, body });
      })
      .catch((err: unknown) => {
        if (!cancelled) setTextError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, isScript]);

  let content;
  if (!asset) {
    content = (
      <div className="placeholder">
        <strong>Preview</strong>
        <span>Select an asset in the library to preview it here.</span>
        <span>The frame matches the project's aspect ratio, so you can see how it will crop.</span>
      </div>
    );
  } else if (isMissing) {
    content = (
      <div className="placeholder">
        <strong>File missing</strong>
        <span>“{asset.name}” is not in the project folder any more. Remove it from the project or restore the file in its assets folder.</span>
      </div>
    );
  } else if (asset.kind === 'html') {
    content = null; // rendered by HtmlPreview below
  } else if (asset.kind === 'image' || asset.kind === 'svg') {
    content = <img src={assetUrl(asset.id)} alt={asset.name} draggable={false} />;
  } else if (asset.kind === 'audio') {
    content = (
      <div className="placeholder">
        <strong>{asset.name}</strong>
        <audio controls src={assetUrl(asset.id)} />
      </div>
    );
  } else if (asset.kind === 'video') {
    content = <video controls src={assetUrl(asset.id)} />;
  } else if (textError) {
    content = <div className="placeholder"><strong>Can't show this file</strong><span>{textError}</span></div>;
  } else if (text && text.id === asset.id) {
    content = <div className="text-view">{prettyText(text.body, asset.ext)}</div>;
  } else {
    content = <div className="placeholder"><span>Loading…</span></div>;
  }

  return (
    <>
      <div className="panel-head">
        <h2>Preview</h2>
        <span className="count">{asset ? `${asset.name} · ${KIND_LABEL[asset.kind]}` : 'No asset selected'}</span>
      </div>
      {isHtml && asset ? (
        <HtmlPreview key={asset.id} project={project} asset={asset} />
      ) : (
        <div className="preview-stage">
          <div className="frame" style={{ '--w': width, '--h': height } as CSSProperties} data-testid="composition-frame">
            {content}
          </div>
        </div>
      )}
      <div className="preview-info">
        <span>{`${width} × ${height} px`}</span>
        <span>·</span>
        <span>{`${s.aspect} · ${s.fps} fps · ${s.durationSec} s`}</span>
        <span style={{ flex: 1 }} />
        <span>Original files are never changed.</span>
      </div>
    </>
  );
}
