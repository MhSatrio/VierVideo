import { useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type { AspectId, ProjectState } from '../model/types';
import { ASPECTS, DEFAULT_SETTINGS, MAX_DURATION_SEC, MIN_DURATION_SEC } from '../../shared/project-format.mjs';

interface Props {
  onCancel(): void;
  onCreated(state: ProjectState): void;
}

export function NewProjectDialog({ onCancel, onCreated }: Props) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [aspect, setAspect] = useState<AspectId>(DEFAULT_SETTINGS.aspect as AspectId);
  const [fps, setFps] = useState<30 | 60>(DEFAULT_SETTINGS.fps as 30 | 60);
  const [duration, setDuration] = useState<number>(DEFAULT_SETTINGS.durationSec);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const chooseParent = async () => {
    setError(null);
    try {
      const dir = await window.vv.pickFolder('Choose where to create the project');
      if (dir) setParent(dir);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const create = async () => {
    setError(null);
    if (!name.trim()) return setError('Enter a name for the project.');
    if (!parent) return setError('Choose the folder where the project should be created.');
    if (!(duration >= MIN_DURATION_SEC && duration <= MAX_DURATION_SEC)) {
      return setError(`Duration must be between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC} seconds.`);
    }
    setWorking(true);
    try {
      const state = await window.vv.createProject({ parentDir: parent, name: name.trim(), settings: { aspect, fps, durationSec: duration } });
      onCreated(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-title">
        <div className="dialog-head">
          <h2 id="new-title">New project</h2>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn icon ghost" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <label className="field">
          <span>Project name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="FTIR in 60 seconds" autoFocus />
        </label>

        <div className="field">
          <span>Save in</span>
          <div className="path-pick">
            <code title={parent ?? ''}>{parent ?? 'No folder chosen'}</code>
            <button className="btn" onClick={chooseParent}>
              <FolderOpen size={16} /> Choose folder
            </button>
          </div>
          {name.trim() && parent && (
            <p className="empty-note">
              A folder named after the project is created inside this location.
            </p>
          )}
        </div>

        <div className="field" role="radiogroup" aria-label="Aspect ratio">
          <span>Aspect ratio</span>
          <div className="aspect-list">
            {ASPECTS.map((a) => {
              const checked = aspect === a.id;
              const glyphW = a.width >= a.height ? 28 : Math.round(28 * a.width / a.height);
              const glyphH = a.height >= a.width ? 28 : Math.round(28 * a.height / a.width);
              return (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={checked}
                  className="aspect-option"
                  onClick={() => setAspect(a.id as AspectId)}
                >
                  <span className="aspect-glyph" style={{ width: glyphW, height: glyphH }} />
                  <span>
                    <strong>{a.id}</strong> · {a.label} · {a.width} × {a.height}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <span>Frame rate</span>
            <div className="seg" role="group" aria-label="Frame rate">
              {[30, 60].map((f) => (
                <button key={f} aria-pressed={fps === f} onClick={() => setFps(f as 30 | 60)}>
                  {f} fps
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Duration (seconds)</span>
            <input type="number" min={MIN_DURATION_SEC} max={MAX_DURATION_SEC} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
          </label>
        </div>

        {error && (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}

        <div className="dialog-foot">
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={working}>
            {working ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}
