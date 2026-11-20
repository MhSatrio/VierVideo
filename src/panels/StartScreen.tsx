import { BookOpen, FolderOpen, Info, Plus, X } from 'lucide-react';
import type { RecentEntry } from '../model/types';
import { formatDateTime } from '../model/format';
import { StatusLine, type Status } from './StatusLine';

interface Props {
  recent: RecentEntry[];
  busy: string | null;
  status: Status | null;
  onNew(): void;
  onOpen(): void;
  onExample(): void;
  onOpenRecent(dir: string): void;
  onForget(dir: string): void;
  onAbout(): void;
  onDismissStatus(): void;
}

export function StartScreen(p: Props) {
  return (
    <div className="start">
      <div className="start-card">
        <div className="brand-row">
          <img src="/icon.svg" alt="" />
          <div>
            <div className="title">VierVideo</div>
            <div className="tag">Turn HTML animations into narrated videos, on this computer.</div>
          </div>
        </div>

        <div className="start-actions">
          <button className="btn primary" onClick={p.onNew}>
            <Plus size={16} /> New project
          </button>
          <button className="btn" onClick={p.onOpen}>
            <FolderOpen size={16} /> Open project
          </button>
          <button className="btn" data-testid="open-example" onClick={p.onExample} title="The FTIR animation with narration, sound and captions, ready to export">
            <BookOpen size={16} /> Open the example
          </button>
          <button className="btn ghost" onClick={p.onAbout}>
            <Info size={16} /> About
          </button>
        </div>

        <div className="recent">
          <h3>Recent projects</h3>
          {p.recent.length === 0 ? (
            <p className="empty-note">No recent projects yet. Create one to start.</p>
          ) : (
            <ul>
              {p.recent.map((r) => (
                <li key={r.dir} className="recent-item">
                  <button className="open" onClick={() => p.onOpenRecent(r.dir)} title={r.dir}>
                    <div className="name">{r.name}</div>
                    <div className="dir">{r.dir}</div>
                    <div className="empty-note">Last opened {formatDateTime(r.openedAt)}</div>
                  </button>
                  <button className="btn icon ghost" onClick={() => p.onForget(r.dir)} aria-label={`Remove ${r.name} from the list`} title="Remove from this list (the project stays on disk)">
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <StatusLine status={p.status} busy={p.busy} onDismiss={p.onDismissStatus} />
      </div>
    </div>
  );
}
