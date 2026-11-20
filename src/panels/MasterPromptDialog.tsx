import { useEffect, useState } from 'react';

/**
 * The master prompt: a description of how VierVideo works (electron/assets/master-prompt.md). It is text to read and copy,
 * not a set of commands. It can be copied to give to an assistant so that it knows where things are and why.
 */
export function MasterPromptDialog({ onClose }: { onClose(): void }) {
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.vv
      .masterPrompt()
      .then(setText)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const copy = async () => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('The text could not be copied. Select it and copy it by hand.');
    }
  };

  return (
    <div className="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog master-prompt" role="dialog" aria-modal="true" aria-labelledby="master-title" data-testid="master-prompt">
        <div className="dialog-head">
          <h2 id="master-title">Master prompt</h2>
        </div>
        <p className="code-note">How VierVideo works: where things are and why. A description, not a list of commands.</p>
        {error && <p className="preview-warning">{error}</p>}
        <pre className="master-text" data-testid="master-text">
          {text ?? 'Loading…'}
        </pre>
        <div className="dialog-foot">
          <button className="btn" onClick={() => void copy()} disabled={text === null} data-testid="master-copy">
            {copied ? 'Copied' : 'Copy all'}
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
