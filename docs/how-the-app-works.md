# VierVideo: how the app works (developer description)

This is a description, not a list of instructions. It says how VierVideo is built and what each part does, so that anyone
(or any AI assistant) reading it can understand where a feature lives and why it works the way it does. Paths are relative
to the project folder `VierVideo/`. Verify a detail in the code before relying on it: the code is the authority.

## 1. What the app is

VierVideo is a local Windows app (Electron 45, React 19, TypeScript, Vite). It turns an HTML animation, usually one drawn
on a canvas, into an MP4 video, with layers (text, images, shapes), narration, sound effects and music. Everything runs on
the computer: no account, no paid service. Narration uses Kokoro-82M through a local Python program.

## 2. Projects and files

- A project is a folder with `project.vvproj.json` (the document: settings, folders, assets, timeline, narration, renders)
  and `assets/` (private copies of the files you imported, named by checksum). The original files you import are never
  changed or moved. Every change is written at once, atomically (`electron/lib/fsx.mjs`, `writeJsonAtomic`), and a
  `.bak` copy is kept.
- The document format and its checks are in `shared/project-format.mjs` (`validateProjectDoc`, `normalizeRenderOptions`,
  `normalizeNarration`, `TRACKS`, `ASPECTS`). The project class is `electron/lib/project.mjs`; every change goes through
  `mutate()`, which serialises writes and validates the result before it is kept.
- Editing an HTML animation as code changes the copy in the project. The first edit keeps the imported copy next to it as
  `<file>.original`, so "Restore original" can bring it back.

## 3. The timeline

- Five tracks: `html` (the one HTML animation, the base picture), `visual` (images, SVG, shapes, HTML elements), `text`,
  `narration` (one clip per narration segment), `music` (music and sound effects). Model and rules: `shared/timeline.mjs`
  (`addClip`, `moveClip`, `trimClip`, `splitClip`, `deleteClip`, `updateClip`, `layerStates`, `validateTimeline`).
- Layers are the clips of kind image, shape, text and snippet (`LAYER_KINDS`). They have a box (`x`, `y`, `w`, `h`) in frame
  pixels, a rotation and an opacity. Layers can be grouped (`groupClips`, `ungroupClips`: the clip's `group` is a shared id).
  A group is selected, moved and resized as one (`shiftLayers`, `scaleLayers`, `scaledRect`). `groupMembers` and `pickIds`
  turn a click into the selection: a click on a layer picks its whole group, and Shift-click adds or removes it.
- A clip has a start and a duration in seconds. Clips may run past the end of the project; export and preview stop at the
  end. A clip is placed at 0 or later.
- Layer order: `layerStates` draws layers in track order (html, visual, text, narration, music), and within a track in the
  order of its clips (later clips are drawn above earlier ones). A clip with `behind` is drawn under the HTML animation.
- The timeline UI is `src/panels/TimelinePanel.tsx`. A press on a clip starts a drag (`begin`); pointer moves update the
  drag (`move`); on release the change is committed once through `onTracks` and saved. Overlapping clips of one track are
  placed in rows (`packRows`), so none hides another. Narration clips move by changing their segment's start time
  (`Project.setTimeline` writes it to the segment); their length is the audio's, so they cannot be trimmed.
- Zoom: pixels per second (`zoom`). The Fit button zooms so that the whole timeline is visible.

## 4. The composition: what is drawn in a frame

- The HTML animation is the base. Layers are drawn over it, one frame at a time, by `electron/lib/render/composition.mjs`
  (`installComposition`, `window.__vvComp.render(state)`). Text, images and shapes are DOM elements in the render page.
- `compositionFrame` (in `electron/main.mjs`) turns the timeline at a time into the state for one frame: the animation time
  (`animMs`), the visible layers, the element offsets and the part offsets of the animation.
- The render page is the animation's own page, loaded in an offscreen window (`electron/lib/render/session.mjs`). It is
  never shown (`paintWhenInitiallyHidden`), so it is not in the taskbar and does not take focus. Frames are captured with
  Chromium's DevTools protocol (`Page.captureScreenshot`).
- Determinism: `electron/lib/render/clock.mjs` replaces `requestAnimationFrame`, timers, `Date` and `Math.random` with a
  virtual clock injected before the page's own scripts run. `advance(ms)` moves time forward and runs the animation's frame
  callbacks, so the same time always gives the same picture. Repeat exports are compared (PSNR at least 45 dB).
- The preview asks for one frame at a time (`renderComposition` IPC) and shows it as a PNG. Export uses the same frames
  (`electron/lib/render/job.mjs`).

## 5. Picking and moving things in the studio

The studio (`src/panels/Studio.tsx`) is a large view of the same frame. A press on the animation finds what is under it:

1. **Parts of a canvas** (`electron/lib/render/canvas-recorder.mjs`). Many animations draw everything on one canvas, so the
   browser sees one element. The recorder wraps the canvas drawing functions (fill, stroke, text, rectangles, images and
   path construction) and records every paint call of each frame: its kind, its text or colour, and its box in frame
   pixels. `__vvOpsPick(x, y)` returns the topmost paint call whose box holds the point, ignoring any paint call that covers
   about the whole frame (the background). A part that is moved gets an offset, stored in the asset's render options as
   `opOffsets`, keyed by the paint call's number within its frame. The offset is applied while the frame is drawn: the path
   or text is made at the shifted position (the offset is turned from frame pixels into the current user space with the
   inverse of the transform's linear part). Preview and export therefore draw the moved part the same way.
   - The number is by order within a frame, so it means something only within one scene: another scene draws other paint
     calls under the same numbers. Each paint call therefore also has a `key` (its kind, its colour without transparency,
     and its text). A move is kept with the part's key and with the stretch of the video where it is the same part
     (`partWindow` in `electron/main.mjs` walks the frames around the pick and halves in on each edge; `activeOpOffsets` in
     `shared/project-format.mjs` sends only the moves whose stretch contains the time). A move saved without these is
     dropped on load.
   - The stretch is found by following the paint call with the same number and key from frame to frame. It ends when the
     number and key change, or when the part moves more than its own size and 80 px in a second. A part that moves that
     fast, or a scene that ends and starts again with the same part, is not one stretch: the move is not carried across.
   - Picking uses boxes, so a click inside a shape's box but off its stroke can select it.
   - There is no front-to-back order for parts of a canvas: they are painted in the order the animation draws them.
2. **DOM elements** (`inspectPage` in `session.mjs`). If no part is under the point, `elementFromPoint` finds the element
   (the composition layers are hidden while looking). Its path (`selector`) is stored in `elementOffsets` as a CSS
   `translate`, which adds to the element's own transform. An element that covers the whole frame (a canvas) is not moved,
   because moving it moves the whole picture (`coversFrame` in `Studio.tsx`).
3. **Code of the element** (`CodeSnippet` and `findElementLine` in `Studio.tsx`). The lines of the animation's source that
   name the element's id, or its first class, are shown with line numbers, as a browser's inspector would show them. If no
   line names it (the script builds it), the element's live HTML is shown.
4. **Zoom and pan** (`src/panels/ZoomStage.tsx`). Ctrl + wheel and pinch zoom about the pointer; the wheel or a two-finger
   scroll pans; the middle button, Space + drag or the grey area pans. Picking and layer dragging read the frame's on-screen
   rectangle, so they keep working when zoomed.
5. **Layers** are picked by a press on their box (`hit` in `src/panels/CompositionPreview.tsx`: the topmost visible layer
   under the point). The selection is a list of clip ids in the App (`selection`); the last id is the one the inspector shows.
   - **Move**: a drag moves the whole selection (`startLayerDrag`). The new position is saved as `x`, `y` on each clip
     (`shiftLayers`). While the drag runs, the layers are drawn where they are going (`view`).
   - **Resize**: the four corner handles of the selection's box (`startResize`) scale the selected layers from the box before
     the drag to the box after it (`scaleLayers`). The corner opposite the one dragged stays in place; each layer keeps its
     place inside the box. Text grows with the box's height. A box never gets smaller than 4 px.
   - **Selection rectangle**: a drag that starts on empty space, or on the whole canvas, draws a dashed rectangle (`marquee`)
     and selects every visible layer it touches. Shift keeps the earlier selection. A drag that starts on a small element of
     the animation moves that element instead (item 2).
   - **Snapping and grid**: with the grid on (`grid-show`), rulers are drawn along the frame's edges and a grid over it, every
     100 px labelled on the rulers. With snapping on (`grid-snap`), a move snaps the selection's top-left corner to the grid
     and a resize snaps the moved corner (`snapD`, `snapV`). Grid size is 10, 25, 50 or 100 px.
   - **Layer list**: the layers drawn at the playhead, top first (`LayerList` in `src/panels/Studio.tsx`), with bring
     forward and send backward (`reorderLayer`). Layers are ordered within their track; the track order comes first.
6. **HTML elements as layers** (kind `snippet`). The studio's Element dialog takes the HTML of one element, pasted or read
   from a file. The element becomes a layer at the playhead. Its HTML is stored in the clip (`html`), not in the animation,
   so the animation's file and its code are not changed. `sanitizeSnippet` (`shared/timeline.mjs`) removes comments,
   scripts, frames, plugins and event attributes, and `javascript:` addresses. The layer is drawn in a shadow root
   (`installComposition` in `electron/lib/render/composition.mjs`), so its styles stay inside it. Its HTML can be edited in
   the inspector. An element is still while a frame is drawn: CSS animations inside it run in real time, not on the
   timeline clock.
7. **Keyboard in the studio**: Ctrl+G groups the selected layers, Ctrl+Shift+G takes them apart, Escape closes the innermost
   open thing (the Element dialog, then the menu, then the studio).

## 6. Narration

- A script (plain text, timed lines like `[00:04 - 00:09] text`, SRT, WebVTT, JSON, CSV) is parsed by `shared/narration.mjs`
  (`parseScript`, `buildSegments`, `layoutStarts`). Each segment has a start time, its text, a voice, a speed and a status.
- Synthesis runs in `tools/tts/worker.py`, a Python program started by `electron/lib/tts/worker.mjs`. It reads JSON lines on
  stdin and writes JSON lines on stdout. It uses Kokoro-82M (`hexgrad/Kokoro-82M`) on the CPU, offline after the first
  download. Voices are listed in `tools/tts/config.json`; pronunciation rules in `tools/tts/pronunciations.json`
  (for example "Vier" is spoken like "veer").
- The Python environment is `%LOCALAPPDATA%\vier-tts\venv`. `tools/tts/setup-narration.ps1` creates it (Python 3.10 to
  3.12, packages from `tools/tts/requirements.txt`, the model into `hf-cache`) and checks that it synthesises a sentence.
- Segment audio files are in `audio/narration/`. Changing the text, voice or speed marks a segment stale.

## 7. Sound

- `shared/audiomix.mjs` (`planAudioMix`) turns the narration and music clips into one FFmpeg filter: each clip is trimmed,
  set to its volume, faded, delayed to its start, summed with `amix`, padded with silence to the project's length, cut to
  it, and limited (`alimiter`). The input numbers start at 1; the export's video is input 0.
- Export (`electron/lib/render/mux.mjs`, `muxArgs`): the video stream is copied, not encoded again, and the mix is encoded as
  AAC (192 kbps, 48 kHz).
- Preview sound (`previewAudio` in `electron/main.mjs`): the same mix is written as a WAV in `audio/preview-<hash>.wav`
  (cached by the mix's content; older ones are removed). The preview plays it in an audio element, and the playback loop
  follows the audio's clock once it runs (`src/panels/CompositionPreview.tsx`).
- Project media (audio, renders) is served by the `vvproj://` scheme, which answers HTTP byte ranges, as the player needs.

## 8. Export and render files

- `electron/lib/render/job.mjs` (`renderVideo`) asks for each frame, sends its PNG to FFmpeg (`electron/lib/render/ffmpeg.mjs`:
  `startEncoder`, `encoderArgs`: libx264, yuv420p, crf 18, MP4). Writes go to `<name>.part`, then are renamed; cancel removes
  the partial file. Renders are recorded in `renders` in the project document.
- FFmpeg is found in this order: the path in the settings, the `VIERVIDEO_FFMPEG` environment variable, the bundled copy
  (installed program), then the PATH (`resolveFfmpeg` in `electron/main.mjs`).

## 9. The Electron structure

- `electron/main.mjs`: the main process. It owns the open project, the windows, the menu (`buildMenu`), and every IPC
  handler (`handle(channel, fn)`, returning `{ ok, data }` or `{ ok, error }`). Test hooks start with `e2e:` and work only
  when `VV_E2E=1`.
- `electron/preload.cjs`: the only bridge. It exposes `window.vv` with a typed API (`src/model/types.ts`, `VvApi`).
- Protocols (registered in `main.mjs`): `vvapp://app/` (the built renderer, from `dist/`), `vvasset://asset/<id>` (a project
  file by its id only), `vvfont://` (the bundled Jost font, so text looks the same everywhere), `vvproj://file/<path>`
  (only `audio/` and `renders/` inside the open project).
- The renderer is React: `src/App.tsx` holds the state (project, selection, playhead, status, dialogs, studio and code
  panel), `src/panels/*` are the panels, `src/styles.css` and `src/panels/features.css` the styles.
- Paths that differ between development and the installed program are in `electron/lib/paths.mjs` (`narrationFiles`,
  `examplePaths`).

## 10. The installed program

- Built by `scripts/dist-win.mjs` (`npm run dist:win`) with electron-builder (NSIS, per-user, x64). The output is
  `%USERPROFILE%\VierVideo-release\VierVideo-Setup-<version>.exe`, outside OneDrive.
- The installer carries FFmpeg (`resources/ffmpeg`), the narration files (`resources/tts`) and the example files
  (`resources/examples`). The app's own code is in `app.asar`; Python cannot read files inside it, so anything Python needs
  is in `resources/`.
- The example project ("Example - FTIR spectroscopy") is created on the first start, in `%USERPROFILE%\VierVideo`. It uses the
  FTIR test animation and a narration script, and shows the layers, the sound and the caption.

## 11. Tests

- Unit tests (`npm test`, Vitest): the timeline model (including layers, groups, scaling and snippets), the project and its
  files, the narration parser, the audio mix, the render job with a fake session, the example and the render options.
- End-to-end tests (`npm run e2e:stage1` ... `e2e:stage5`, `e2e:usability`, plus `tests/e2e/feedback7.mjs`,
  `tests/e2e/parts7.mjs` and `tests/e2e/layers8.mjs`): they start the built app and drive it over the DevTools protocol with
  `playwright-core`. Each uses its own port (9339 to 9370) and its own user-data folder. Mouse drags are real pointer events.
  Keys: keys sent over the DevTools protocol do not reach the app's key handling, so the full-screen check uses real Windows
  key presses.
- The installed-program test (`npm run e2e:installed`) installs the built installer into a temporary folder, runs it and
  uninstalls it. It changes the Start menu shortcut while it runs.

## 12. What is not done yet, and known limits

- No front-to-back order for parts of a canvas (see section 5, item 1). Layers (text, images, shapes, HTML elements) have a
  draw order from the timeline.
- Groups are one level deep: a layer belongs to one group at most, and groups cannot contain groups.
- Resize uses the four corners only (no edge handles, no rotation handle). The selection rectangle works on the layers at
  the playhead; a group's members that are not visible at the playhead still move and resize with the group.
- An HTML element layer is a picture of the element at each frame. Scripts are not run, and its CSS animations are not
  tied to the timeline clock, so an element that must animate has to be made in the animation itself.
- Parts are numbered by their order in a frame, and a part is recognised again by its key within a stretch of the video
  (see section 5, item 1). If two parts in one scene have the same number, key and place in consecutive frames, they cannot
  be told apart and move together. A part that moves faster than its own size and 80 px a second is not followed across
  frames, so its move ends early.
- Picking a part uses its box, not its exact outline.
- Element moves use CSS `translate`. For SVG children inside a scaled viewBox, the offset in frame pixels may not match the
  visible distance.
- Stored offsets refer to an element's path (with its tag and id) or to a part's number, key and stretch of the video, so
  they stop applying if the animation changes those.
- The installed program has not been tested with the newest features; the development build has.
