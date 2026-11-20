// Preload: the only bridge between the page and the main process. Exposes a small, typed API as window.vv.
// Every call resolves to the data or rejects with a readable Error message.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, payload) {
  const res = await ipcRenderer.invoke(channel, payload);
  if (!res || !res.ok) throw new Error((res && res.error) || 'Something went wrong.');
  return res.data;
}

contextBridge.exposeInMainWorld('vv', {
  info: () => call('app:info'),
  recent: () => call('recent:list'),
  forgetRecent: (dir) => call('recent:remove', { dir }),
  pickFolder: (title) => call('dialog:pickFolder', { title }),
  pickFiles: () => call('dialog:pickFiles'),
  // Files dropped onto the page have no path in the page; webUtils gives it back.
  pathsForFiles: (files) => Array.from(files, (f) => webUtils.getPathForFile(f)),

  state: () => call('project:state'),
  createProject: (p) => call('project:create', p),
  openProject: (dir) => call('project:open', { dir }),
  closeProject: () => call('project:close'),
  save: () => call('project:save'),
  updateSettings: (patch) => call('project:updateSettings', patch),
  renameProject: (name) => call('project:rename', { name }),
  revealProject: () => call('project:reveal'),

  importFiles: (paths, folderId) => call('assets:import', { paths, folderId: folderId ?? null }),
  removeAsset: (id) => call('assets:remove', { id }),
  renameAsset: (id, name) => call('assets:rename', { id, name }),
  moveAsset: (id, folderId) => call('assets:move', { id, folderId: folderId ?? null }),
  readText: (id) => call('assets:readText', { id }),
  // Edit an HTML animation as code. The change is made to the copy inside the project; the original is kept.
  writeAssetText: (id, text) => call('assets:writeText', { id, text }),
  restoreAssetOriginal: (id) => call('assets:restoreOriginal', { id }),

  // Example project: opened by itself on the first start, and by the start screen button.
  startExample: () => call('example:start'),
  openExample: () => call('example:open'),

  createFolder: (name) => call('folders:create', { name }),
  renameFolder: (id, name) => call('folders:rename', { id, name }),
  deleteFolder: (id) => call('folders:delete', { id }),

  setRenderOptions: (id, opts) => call('assets:renderOptions', { id, ...opts }),

  // Timeline and composition (Stage 4)
  saveTimeline: (tracks) => call('timeline:save', { tracks }),
  renderComposition: (timeMs) => call('render:composition', { timeMs }),
  exportComposition: (p) => call('render:exportComposition', p),
  // The element of the animation under a point of the frame (frame pixels), at a time (for the studio).
  inspectElement: (timeMs, x, y) => call('composition:inspect', { timeMs, x, y }),
  // The timeline's sound as a WAV file in the project (for playing the preview with sound).
  previewAudio: () => call('preview:audio'),
  // The paint calls of the animation at a time (the parts the studio lists and picks).
  listParts: (timeMs) => call('composition:parts', { timeMs }),
  partWindow: (timeSec, index, key) => call('composition:partWindow', { timeSec, index, key }),

  // Rendering. Preview frames are PNG bytes as base64.
  renderPreview: (assetId, timeMs) => call('render:preview', { assetId, timeMs }),
  closePreview: () => call('render:closePreview'),
  exportVideo: (p) => call('render:export', p),
  cancelExport: (id) => call('render:cancel', { id }),
  revealRender: (file) => call('render:reveal', { file }),
  ffmpegStatus: () => call('ffmpeg:status'),
  chooseFfmpeg: () => call('ffmpeg:choose'),
  onRenderProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('render:progress', listener);
    return () => ipcRenderer.removeListener('render:progress', listener);
  },

  // Narration (Stage 3)
  ttsVoices: () => call('tts:voices'),
  ttsStatus: () => call('tts:status'),
  chooseTtsPython: () => call('tts:choosePython'),
  setNarration: (p) => call('narration:set', p),
  setNarrationSettings: (p) => call('narration:settings', p),
  editSegment: (id, text) => call('narration:edit', { id, text }),
  clearNarration: () => call('narration:clear'),
  generateNarration: (segmentIds) => call('narration:generate', { segmentIds: segmentIds ?? null }),
  cancelNarration: () => call('narration:cancel'),
  previewVoice: (voice, speed) => call('narration:preview', { voice, speed }),
  onNarrationProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('narration:progress', listener);
    return () => ipcRenderer.removeListener('narration:progress', listener);
  },

  onMenu: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.removeListener('menu:action', listener);
  },

  // The master prompt: a description of how the app works (text), shown and copied from the Master prompt menu.
  masterPrompt: () => call('app:masterPrompt'),

  // Full screen: F11 and Escape toggle it; the page is told when it changes.
  setFullScreen: (on) => call('window:setFullScreen', { on }),
  onFullScreen: (callback) => {
    const listener = (_event, on) => callback(Boolean(on));
    ipcRenderer.on('window:fullscreen', listener);
    return () => ipcRenderer.removeListener('window:fullscreen', listener);
  },

  // Test hooks; the main process refuses them unless VV_E2E=1.
  e2eSetPicks: (picks) => call('e2e:setPicks', picks),
  e2eWindows: () => call('e2e:windows'),
  e2eAnimationDevtools: () => call('e2e:animationDevtools'),
  e2eOps: (timeMs) => call('e2e:ops', { timeMs }),
});
