// Types for the project document and the window.vv API exposed by electron/preload.cjs.
// The document layout is defined in shared/project-format.mjs (validated there).

export type AssetKind = 'image' | 'svg' | 'html' | 'script' | 'audio' | 'video';
export type AspectId = '9:16' | '16:9' | '1:1';

export interface ProjectSettings {
  aspect: AspectId;
  fps: 30 | 60;
  durationSec: number;
}

export interface ProjectFolder {
  id: string;
  name: string;
}

export type RenderMode = 'deterministic' | 'realtime';

export interface RenderOptions {
  mode: RenderMode;
  hideSelectors: string;
  /** Elements of the animation moved in the studio: a path to the element, its tag and id (the offset applies only while
   * the element at that path is this one), and its offset in frame pixels. */
  elementOffsets?: Array<{ selector: string; tag: string; id: string; x: number; y: number }>;
  /**
   * Parts of a canvas-drawn animation moved in the studio: the paint call's number, what it is (`key`), the stretch of the
   * video where it is the same part (t0 to t1, seconds), and its offset. See shared/project-format.mjs.
   */
  opOffsets?: Array<{ index: number; kind: string; text: string; key: string; t0: number; t1: number; sx: number; sy: number; dx: number; dy: number }>;
  /** Canvas parts grouped in the studio: the group, and each part (its number, key and stretch of the video). */
  partGroups?: Array<{ group: string; index: number; kind: string; text: string; key: string; t0: number; t1: number }>;
}

/** A canvas part picked in the studio: its number and key (the stretch of the video is the playhead's). */
export interface PartKey {
  index: number;
  key: string;
}

/** A paint call of the canvas, with its box in frame pixels (null when it has none, e.g. a Path2D). */
export interface PartRecord extends PartInfo {
  bbox: [number, number, number, number] | null;
}

/** A part of a canvas-drawn animation: one paint call (a circle, a line, a letter), as the studio picks it. */
export interface PartInfo {
  index: number;
  kind: string;
  text: string;
  color: string;
  /** What the part is, apart from its number (kind, colour without transparency, text): a move is kept with it. */
  key: string;
}

export interface ProjectAsset {
  id: string;
  name: string;
  originalName: string;
  kind: AssetKind;
  ext: string;
  mime: string;
  bytes: number;
  sha256: string;
  file: string;
  folderId: string | null;
  addedAt: string;
  render?: RenderOptions;
  /** HTML animations only: the code was changed in the project (the original copy is kept). */
  edited?: boolean;
  editedAt?: string;
}

/** An element of the HTML animation, found under a point of the frame (for the studio). */
export interface ElementInfo {
  tag: string;
  id: string;
  classes: string[];
  text: string;
  /** The element as it is in the page right now (its HTML, cut to the first 1500 characters). */
  html: string;
  selector: string;
  rect: { x: number; y: number; w: number; h: number };
  /** A part of a canvas-drawn animation (set instead of a DOM element when a part is under the point). */
  op?: PartInfo;
}

export interface RenderRecord {
  id: string;
  assetId: string | null;
  kind?: 'timeline';
  file: string;
  fps: number;
  durationSec: number;
  mode: RenderMode;
  frames: number;
  bytes: number;
  /** Timeline exports only: how many narration and music clips were mixed into the sound. */
  audioClips?: number;
  createdAt: string;
}

export interface RenderProgress {
  id: number;
  frame: number;
  total: number;
  percent: number;
}

export interface PreviewFrame {
  png: string; // base64 PNG
  warnings: string[];
}

export interface FfmpegInfo {
  path: string;
  source: string;
  version: string;
}

export type ClipKind = 'html' | 'image' | 'shape' | 'text' | 'snippet' | 'audio';
export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow';

export interface TimelineClip {
  id: string;
  track: string;
  kind: ClipKind;
  name: string;
  start: number;
  duration: number;
  assetId?: string | null;
  segmentId?: string | null;
  offset?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotation?: number;
  opacity?: number;
  fadeIn?: number;
  fadeOut?: number;
  behind?: boolean;
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  shape?: ShapeKind;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  volume?: number;
  /** Layers in one group are selected and moved together (a short id; null when not grouped). */
  group?: string | null;
  /** Snippets only: the HTML element as written (scripts and event attributes are removed). */
  html?: string;
}

export interface TimelineTrack {
  id: string;
  name: string;
  clips: TimelineClip[];
}

export type SegmentStatus = 'pending' | 'ok' | 'stale' | 'error';

export interface NarrationSegment {
  id: string;
  index: number;
  start: number | null;
  end: number | null;
  text: string;
  status: SegmentStatus;
  file: string | null;
  durationSec: number | null;
  signature: string | null;
  error: string | null;
}

export interface Narration {
  sourceAssetId: string | null;
  voice: string;
  speed: number;
  segments: NarrationSegment[];
}

export interface Voice {
  id: string;
  label: string;
  accent: string;
  gender: string;
}

export interface TtsStatus {
  python: { path: string; source: string; version: string } | null;
  ready: boolean;
  error?: string;
}

export interface NarrationProgress {
  total: number;
  done: number;
  segmentId?: string;
  error?: string;
}

export interface ProjectDoc {
  format: string;
  version: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: ProjectSettings;
  folders: ProjectFolder[];
  assets: ProjectAsset[];
  renders: RenderRecord[];
  narration: Narration | null;
  timeline: { durationSec?: number; tracks: TimelineTrack[] };
}

export interface ProjectState {
  dir: string;
  doc: ProjectDoc;
  missing: string[];
  savedAt: string | null;
}

export interface RecentEntry {
  dir: string;
  name: string;
  openedAt: string;
}

export interface AppInfo {
  name: string;
  version: string;
  e2e: boolean;
  platform: string;
}

export interface ImportResult {
  source: string;
  name: string;
  status: 'imported' | 'duplicate' | 'skipped';
  reason?: string;
}

export interface VvApi {
  info(): Promise<AppInfo>;
  recent(): Promise<RecentEntry[]>;
  forgetRecent(dir: string): Promise<RecentEntry[]>;
  pickFolder(title?: string): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  pathsForFiles(files: FileList | File[]): string[];
  state(): Promise<ProjectState | null>;
  createProject(p: { parentDir: string; name: string; settings: ProjectSettings }): Promise<ProjectState>;
  openProject(dir: string): Promise<ProjectState>;
  closeProject(): Promise<null>;
  save(): Promise<ProjectState>;
  updateSettings(patch: Partial<ProjectSettings>): Promise<ProjectState>;
  renameProject(name: string): Promise<ProjectState>;
  revealProject(): Promise<true>;
  importFiles(paths: string[], folderId?: string | null): Promise<{ results: ImportResult[]; state: ProjectState }>;
  removeAsset(id: string): Promise<ProjectState>;
  renameAsset(id: string, name: string): Promise<ProjectState>;
  moveAsset(id: string, folderId: string | null): Promise<ProjectState>;
  readText(id: string): Promise<string>;
  writeAssetText(id: string, text: string): Promise<ProjectState>;
  restoreAssetOriginal(id: string): Promise<ProjectState>;
  inspectElement(timeMs: number, x: number, y: number): Promise<ElementInfo | null>;
  previewAudio(): Promise<{ file: string | null; durationSec: number }>;
  masterPrompt(): Promise<string>;
  listParts(timeMs: number): Promise<PartRecord[]>;
  partWindow(timeSec: number, index: number, key: string): Promise<{ t0: number; t1: number } | null>;
  startExample(): Promise<{ state: ProjectState; created: boolean } | null>;
  openExample(): Promise<{ state: ProjectState; created: boolean }>;
  setFullScreen(on: boolean): Promise<boolean>;
  onFullScreen(cb: (on: boolean) => void): () => void;
  e2eWindows(): Promise<Array<{ title: string; visible: boolean; fullScreen: boolean }>>;
  createFolder(name: string): Promise<ProjectState>;
  renameFolder(id: string, name: string): Promise<ProjectState>;
  deleteFolder(id: string): Promise<ProjectState>;
  setRenderOptions(id: string, opts: Partial<RenderOptions>): Promise<ProjectState>;
  saveTimeline(tracks: TimelineTrack[]): Promise<ProjectState>;
  renderComposition(timeMs: number): Promise<PreviewFrame>;
  exportComposition(p: { fps?: number; durationSec?: number }): Promise<{ id: number; render: RenderRecord; warnings: string[]; state: ProjectState }>;
  renderPreview(assetId: string, timeMs: number): Promise<PreviewFrame>;
  closePreview(): Promise<true>;
  exportVideo(p: { assetId: string; fps?: number; durationSec?: number; mode?: RenderMode }): Promise<{ id: number; render: RenderRecord; warnings: string[]; state: ProjectState }>;
  cancelExport(id: number): Promise<boolean>;
  revealRender(file: string): Promise<true>;
  ffmpegStatus(): Promise<FfmpegInfo | null>;
  chooseFfmpeg(): Promise<FfmpegInfo | null>;
  onRenderProgress(cb: (p: RenderProgress) => void): () => void;
  onMenu(cb: (action: string) => void): () => void;
  ttsVoices(): Promise<{ voices: Voice[]; defaultVoice: string; speedMin: number; speedMax: number }>;
  ttsStatus(): Promise<TtsStatus>;
  chooseTtsPython(): Promise<TtsStatus | null>;
  setNarration(p: { sourceAssetId: string; voice: string; speed: number; segments: NarrationSegment[] }): Promise<ProjectState>;
  setNarrationSettings(p: { voice?: string; speed?: number }): Promise<ProjectState>;
  editSegment(id: string, text: string): Promise<ProjectState>;
  clearNarration(): Promise<ProjectState>;
  generateNarration(segmentIds?: string[]): Promise<{ done: number; failed: number; cancelled: boolean; state: ProjectState }>;
  cancelNarration(): Promise<boolean>;
  previewVoice(voice: string, speed: number): Promise<{ file: string }>;
  onNarrationProgress(cb: (p: NarrationProgress) => void): () => void;
  e2eSetPicks(p: { folder?: string | null; files?: string[]; ffmpeg?: string | null; python?: string | null }): Promise<true>;
}

declare global {
  interface Window {
    vv: VvApi;
  }
}
