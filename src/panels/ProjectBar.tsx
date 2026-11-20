import { FolderOpen, Info, Save, Upload, X } from 'lucide-react';
import { formatTimeOnly } from '../model/format';

interface Props {
  name: string;
  savedAt: string | null;
  onImport(): void;
  onSave(): void;
  onReveal(): void;
  onClose(): void;
  onAbout(): void;
}

export function ProjectBar({ name, savedAt, onImport, onSave, onReveal, onClose, onAbout }: Props) {
  return (
    <div className="topbar">
      <img src="/icon.svg" alt="" />
      <span className="app-name">VierVideo</span>
      <span className="project-name" title={name}>{name}</span>
      <span className="saved">{savedAt ? `Saved ${formatTimeOnly(savedAt)}` : 'Not saved yet'}</span>
      <div className="spacer" />
      <div className="toolbar">
        <button className="btn" onClick={onImport}>
          <Upload size={16} /> Import
        </button>
        <button className="btn" onClick={onSave} title="Save now (Ctrl+S). Changes are also saved automatically.">
          <Save size={16} /> Save
        </button>
        <button className="btn ghost" onClick={onReveal}>
          <FolderOpen size={16} /> Project folder
        </button>
        <button className="btn ghost" onClick={onAbout}>
          <Info size={16} /> About
        </button>
        <button className="btn ghost" onClick={onClose}>
          <X size={16} /> Close project
        </button>
      </div>
    </div>
  );
}
