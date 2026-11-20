import { useEffect, useState, type KeyboardEvent } from 'react';
import { RotateCcw, Save, X } from 'lucide-react';
import type { ProjectAsset } from '../model/types';

interface Props {
  asset: ProjectAsset;
  onSave(text: string): Promise<boolean>;
  onRestore(): Promise<boolean>;
  onClose(): void;
}

/**
 * The code of the HTML animation, in the right-hand panel. Saving changes the copy inside the project: the file you
 * imported is never changed, and the original stays available (Restore original).
 */
export function CodeEditor({ asset, onSave, onRestore, onClose }: Props) {
  const [saved, setSaved] = useState<string | null>(null); // the text on disk
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reload whenever the file changes (a save, or a restore).
  useEffect(() => {
    let alive = true;
    setSaved(null);
    setError(null);
    window.vv
      .readText(asset.id)
      .then((t) => {
        if (!alive) return;
        setSaved(t);
        setText(t);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [asset.id, asset.sha256]);

  const dirty = saved !== null && text !== saved;

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    const ok = await onSave(text);
    setBusy(false);
    if (!ok) setError('The code was not saved. The message is in the status line below.');
  };

  const restore = async () => {
    if (busy) return;
    if (dirty && !window.confirm('Discard your unsaved changes and put back the original animation?')) return;
    setBusy(true);
    setError(null);
    await onRestore();
    setBusy(false);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="code-editor" data-testid="code-editor">
      <div className="code-head">
        <div>
          <strong>Animation code</strong>
          <div className="count" title={asset.name}>
            {asset.name}
            {asset.edited ? ' · edited' : ''}
          </div>
        </div>
        <button className="btn icon ghost" aria-label="Close the code" title="Back to the inspector" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <p className="code-note">Changes are saved in this project. The file you imported is not changed.</p>
      <textarea
        className="code-text"
        data-testid="code-text"
        aria-label="Animation code"
        value={text}
        spellCheck={false}
        wrap="off"
        disabled={saved === null || busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="code-actions">
        <button className="btn primary" data-testid="code-save" onClick={() => void save()} disabled={!dirty || busy}>
          <Save size={14} /> Save
        </button>
        <button className="btn ghost" data-testid="code-revert" onClick={() => saved !== null && setText(saved)} disabled={!dirty || busy}>
          Revert
        </button>
        {asset.edited && (
          <button className="btn ghost" data-testid="code-restore" onClick={() => void restore()} disabled={busy}>
            <RotateCcw size={14} /> Restore original
          </button>
        )}
        <span className="code-state" data-testid="code-state">
          {error ? error : dirty ? 'Unsaved changes (Ctrl+S saves)' : saved === null ? 'Loading…' : 'Saved'}
        </span>
      </div>
    </div>
  );
}
