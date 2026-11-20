import { X } from 'lucide-react';

export interface Status {
  kind: 'info' | 'error';
  text: string;
}

export function StatusLine({ status, busy, onDismiss }: { status: Status | null; busy: string | null; onDismiss: () => void }) {
  if (status?.kind === 'error') {
    return (
      <div className="status-line error" role="alert">
        <span>{status.text}</span>
        <span className="spacer" />
        <button className="btn icon ghost" onClick={onDismiss} aria-label="Dismiss message">
          <X size={14} />
        </button>
      </div>
    );
  }
  const text = busy ?? status?.text ?? 'Ready.';
  return (
    <div className="status-line info" role="status" aria-live="polite">
      <span>{text}</span>
      <span className="spacer" />
      {status && !busy && (
        <button className="btn icon ghost" onClick={onDismiss} aria-label="Dismiss message">
          <X size={14} />
        </button>
      )}
    </div>
  );
}
