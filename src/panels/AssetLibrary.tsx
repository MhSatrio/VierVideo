import { useState, type FormEvent } from 'react';
import { FileText, Film, FolderPlus, Image as ImageIcon, Music, Pencil, Trash2, Upload, Video, X, Check } from 'lucide-react';
import type { ProjectAsset, ProjectState } from '../model/types';
import { KIND_LABEL } from '../../shared/project-format.mjs';
import { assetUrl, formatBytes } from '../model/format';

interface Props {
  project: ProjectState;
  selectedId: string | null;
  onSelect(id: string | null): void;
  folderFilter: string;
  onFolderFilter(f: string): void;
  onImport(): void;
  onDropPaths(paths: string[]): void;
  onCreateFolder(name: string): Promise<unknown>;
  onRenameFolder(id: string, name: string): Promise<unknown>;
  onDeleteFolder(id: string): Promise<unknown>;
}

const KIND_ICON = {
  image: ImageIcon,
  svg: ImageIcon,
  html: Film,
  script: FileText,
  audio: Music,
  video: Video,
} as const;

function AssetThumb({ asset }: { asset: ProjectAsset }) {
  if (asset.kind === 'image' || asset.kind === 'svg') {
    return (
      <div className="thumb">
        <img src={assetUrl(asset.id)} alt="" draggable={false} />
      </div>
    );
  }
  const Icon = KIND_ICON[asset.kind];
  return (
    <div className="thumb" aria-hidden="true">
      <Icon size={24} />
    </div>
  );
}

export function AssetLibrary(p: Props) {
  const doc = p.project.doc;
  const missing = new Set(p.project.missing);
  const [dragging, setDragging] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isFolder = p.folderFilter !== 'all' && p.folderFilter !== 'unfiled';
  const currentFolder = isFolder ? doc.folders.find((f) => f.id === p.folderFilter) ?? null : null;
  const visible = doc.assets.filter((a) => {
    if (p.folderFilter === 'all') return true;
    if (p.folderFilter === 'unfiled') return a.folderId == null;
    return a.folderId === p.folderFilter;
  });
  const countIn = (f: string) => doc.assets.filter((a) => (f === 'all' ? true : f === 'unfiled' ? a.folderId == null : a.folderId === f)).length;

  const selectFilter = (f: string) => {
    setRenaming(false);
    setConfirmDelete(false);
    p.onFolderFilter(f);
  };

  const submitNewFolder = async (e: FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    const ok = await p.onCreateFolder(newFolderName.trim());
    if (ok) {
      setNewFolderName('');
      setNewFolderOpen(false);
    }
  };

  const submitRename = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentFolder || !renameText.trim()) return;
    const ok = await p.onRenameFolder(currentFolder.id, renameText.trim());
    if (ok) setRenaming(false);
  };

  return (
    <>
      <div className="panel-head">
        <h2>Assets</h2>
        <span className="count">{doc.assets.length}</span>
        <span className="spacer" />
        <button className="btn" onClick={p.onImport}>
          <Upload size={16} /> Import
        </button>
      </div>

      <div className="folder-bar">
        <button className="chip" aria-pressed={p.folderFilter === 'all'} onClick={() => selectFilter('all')}>
          All <span className="n">{countIn('all')}</span>
        </button>
        <button className="chip" aria-pressed={p.folderFilter === 'unfiled'} onClick={() => selectFilter('unfiled')}>
          Unfiled <span className="n">{countIn('unfiled')}</span>
        </button>
        {doc.folders.map((f) => (
          <button key={f.id} className="chip" aria-pressed={p.folderFilter === f.id} onClick={() => selectFilter(f.id)}>
            {f.name} <span className="n">{countIn(f.id)}</span>
          </button>
        ))}
        {newFolderOpen ? (
          <form className="inline-form" onSubmit={submitNewFolder}>
            <input
              type="text"
              aria-label="New folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Folder name"
              autoFocus
              maxLength={60}
            />
            <button className="btn icon" type="submit" aria-label="Create folder" disabled={!newFolderName.trim()}>
              <Check size={16} />
            </button>
            <button className="btn icon ghost" type="button" aria-label="Cancel" onClick={() => setNewFolderOpen(false)}>
              <X size={16} />
            </button>
          </form>
        ) : (
          <button className="chip" onClick={() => setNewFolderOpen(true)} aria-label="New folder">
            <FolderPlus size={14} /> New folder
          </button>
        )}
      </div>

      {currentFolder && (
        <div className="folder-bar">
          {renaming ? (
            <form className="inline-form" onSubmit={submitRename}>
              <input
                type="text"
                aria-label="Folder name"
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                autoFocus
                maxLength={60}
              />
              <button className="btn icon" type="submit" aria-label="Save folder name">
                <Check size={16} />
              </button>
              <button className="btn icon ghost" type="button" aria-label="Cancel rename" onClick={() => setRenaming(false)}>
                <X size={16} />
              </button>
            </form>
          ) : (
            <>
              <span className="label">Folder “{currentFolder.name}”</span>
              <div className="folder-tools">
                <button
                  className="btn icon ghost"
                  aria-label="Rename folder"
                  title="Rename folder"
                  onClick={() => {
                    setRenameText(currentFolder.name);
                    setRenaming(true);
                  }}
                >
                  <Pencil />
                </button>
                <button
                  className={confirmDelete ? 'btn danger' : 'btn icon ghost'}
                  aria-label={confirmDelete ? 'Confirm delete folder' : 'Delete folder'}
                  title="Delete folder. Its assets move to Unfiled."
                  onClick={async () => {
                    if (!confirmDelete) return setConfirmDelete(true);
                    await p.onDeleteFolder(currentFolder.id);
                    setConfirmDelete(false);
                    p.onFolderFilter('all');
                  }}
                >
                  {confirmDelete ? 'Confirm' : <Trash2 />}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div
        className={`drop-zone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          p.onDropPaths(window.vv.pathsForFiles(e.dataTransfer.files));
        }}
      >
        {doc.assets.length === 0 && (
          <div className="drop-hint">
            <p>
              Drop images, SVG logos, HTML animations, scripts (TXT, Markdown, JSON, CSV), audio or video here.
            </p>
            <p style={{ marginTop: 10 }}>
              <button className="btn" onClick={p.onImport}>
                <Upload size={16} /> Choose files
              </button>
            </p>
          </div>
        )}
        {doc.assets.length > 0 && visible.length === 0 && (
          <p className="empty-note">No assets in this folder. Import files here or move assets into it from the Inspector.</p>
        )}
        {visible.map((a) => (
          <button
            key={a.id}
            className="asset-card"
            aria-pressed={p.selectedId === a.id}
            onClick={() => p.onSelect(p.selectedId === a.id ? null : a.id)}
            title={a.originalName}
          >
            <AssetThumb asset={a} />
            <span style={{ minWidth: 0 }}>
              <span className="name" style={{ display: 'block' }}>{a.name}</span>
              <span className="meta">
                <span>{KIND_LABEL[a.kind]}</span>
                <span>·</span>
                <span>{formatBytes(a.bytes)}</span>
                {missing.has(a.id) && <span className="badge warn">Missing file</span>}
              </span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
