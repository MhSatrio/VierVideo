# VierVideo — environment audit, architecture and phased plan

Status date: 2026-11-17. Written for the developer (Muhammad Satrio) and for VierApparatus.
Private use: VierVideo is not distributed, so there is no licence file and the FFmpeg build may be GPL.

## 1. Environment audit (this PC)

| Item | Found | Use in VierVideo |
|---|---|---|
| Node.js / npm | v24.13.1 | Build, tests, Electron |
| Python | 3.12.10 (global) | Not used for TTS. Only for helper scripts |
| FFmpeg / FFprobe | 8.1.1 "full" build (Gyan, winget). Has `libx264`, `aac`, `libmp3lame`, `libopus`, hardware H.264 (NVENC, QSV, AMF). Filters `loudnorm`, `alimiter`, `deesser`, `afade`, `xfade`, `overlay`, `subtitles` present. On PATH | Encoding. The app finds it through settings, the `VIERVIDEO_FFMPEG` variable, or PATH. No hard-coded path |
| Chromium | Playwright `chromium-1248` in `%LOCALAPPDATA%\ms-playwright` (DCE tests use it) | Spike only. The app renders with Electron's own Chromium |
| Electron | 45.x in this project's `node_modules` | Desktop shell (same major version as DCE) |
| electron-builder | 26.x (DCE devDependency) | Windows installer, if it is ever needed |
| Remotion | 4.0.539 in `vier-methods-batch-6` and `vier-intro-video` | Not reused |
| Kokoro-82M TTS | Venv `%LOCALAPPDATA%\vier-tts\venv` (Python 3.12, `kokoro` 0.9.4, `misaki` 0.9.4, `torch` 2.15.0 CPU, `onnxruntime`, `espeakng-loader`, `soundfile`, `scipy`, `pyloudnorm` 0.2.0). Model cache `%LOCALAPPDATA%\vier-tts\hf-cache`: 0.45 GB, 23 files, including 8 voices | Narration engine (Stage 3) |
| RAM / disk | 7.2 GB RAM; about 0.5 GB free during testing | Electron and offscreen Chromium run fine, one render window per session |

**Can the TTS run fully offline?** Yes, once the model is cached. Kokoro runs on the CPU and needs no account or key. Set `HF_HUB_OFFLINE=1` in the worker so a missing model fails instead of downloading.

## 2. Review of the DCE editor (what to reuse)

DCE is React 19 + Vite 7 + TypeScript + Fabric 6 + Dexie, packaged with Electron 45 and electron-builder (NSIS).

- **Shared engine** (`DCE/src/engine/*`): a DOM-free renderer used by the editor, preview and batch worker. `expr.ts` is a safe expression parser (no `eval`); `textfit.ts` shrinks, truncates or hides text to fit a box.
- **Editor**: one Fabric 6 class (`DceObject`) draws through the same code as the batch renderer. The saved truth is a validated `.njs` document. `src/editor/controller.ts` handles history, selection and snapping; `src/editor/Inspector.tsx` is the property panel.
- **Batch**: `src/batch/runner.ts` is a worker pool with pause, resume, cancel and retry.
- **Desktop shell**: `DCE/desktop/main.cjs` and `scripts/dist-win.mjs`.
- **Styles**: `src/styles/global.css` holds the VierApparatus tokens. Copied into VierVideo.

| DCE part | VierVideo | When |
|---|---|---|
| Design tokens, panel layout | Reused (copied tokens, same look) | Stage 1 (done) |
| Electron 45 + Vite + React setup | Reused in spirit. `vvapp://` replaces DCE's loopback server | Stage 1 (done) |
| Batch worker pool, cancel and progress | Pattern for frame export | Stage 2 (done, re-implemented in `electron/lib/render/job.mjs`) |
| Fabric 6 `DceObject` + draw code | Overlay layers (text, shapes, images over the HTML) | Stage 4 |
| Inspector pattern (tabs, bindings, inputs) | Element inspector | Stage 4 |
| `expr.ts`, `textfit.ts` | Captions and template-like text | Stage 4 |
| Dexie / IndexedDB | **Not used.** A project is a folder with a JSON file and an `assets/` folder | Stage 1 (done) |
| Website connectors, Gemini, Buffer, pipeline, cloud upload | **Not used** | — |

## 3. Review of the local TTS in `vier-methods-batch-6`

Engine: **Kokoro-82M** (`hexgrad/Kokoro-82M`, Apache-2.0). Config in `tts/config.json` (default voice `af_heart`, speed 1.0, `lang_code` `a`).

How it works (`tts/vier_tts.py`):
1. `prep_text()` rewrites the script with `tts/pronunciations.json` (acronyms spelled out, inline phonemes for hard words).
2. Each sentence is synthesised with `KPipeline`, joined with a 0.18 s pause.
3. `trim()` removes silence below −50 dB with a 30 ms pad; `fade()` adds 12 ms fades.
4. The track is de-essed (`ffmpeg deesser`), loudness-normalised to −16 LUFS and limited (`alimiter`, peak 0.79).
5. Output per line is cached by a signature of text, voice and speed.

**Voice pack (local cache, 8 voices):** `af_bella`, `af_heart`, `af_nicole`, `af_sarah` (American English, female), `am_fenrir`, `am_michael` (American English, male), `bf_emma` (British English, female), `bm_george` (British English, male).

**Decisions from the user (2026-11-17):**
- The voice is chosen from the voice pack in VierVideo. No single voice is fixed (`af_heart` is only the batch-6 default).
- "Vier" is spoken **"veer"**. The rule goes in VierVideo's own pronunciation list, not in batch-6's.
- The FTIR example is the default test file.

What to reuse: `vier_tts.py` (`prep_text`, `synth`, `trim`, `fade`, `signature`) and `pronunciations.json`. Do **not** port `build_narration.py`'s timeline warp, which is specific to the Remotion films. VierVideo places each segment on its own timestamp.

Limits: English only (`lang_code` `a` for American, `b` for British voices); emotion limited to punctuation; roughly 1–3 s of compute per second of speech on this CPU.

## 4. Rendering the example HTML (decided and built in Stage 2)

The FTIR example is a 1080×1920 canvas, 60 s long. It has no `renderAt` hook. `draw(t)` sits inside an IIFE and is driven by `requestAnimationFrame(frame)` with `performance.now()`. Its narration is a `SUBS` array of `[start, end, text]` lines, a ready-made timed script for Stage 3.

The spike (`spikes/render-spike.mjs`) showed that a virtual clock makes seeking deterministic without editing the file. Stage 2 built the same idea into the app (see §6).

## 5. Stack and folder structure

**Stack (matches DCE):** Electron 45, React 19, Vite 7, TypeScript 5.7, Vitest 3, playwright-core for end-to-end tests over CDP, lucide-react, `@fontsource-variable/jost`. Rendering: an offscreen Electron window per session, controlled through `webContents.debugger` (CDP). FFmpeg from the system or a configured path. Kokoro (Stage 3) as a child process of the venv's Python.

```
VierVideo/
  package.json, vite.config.ts, tsconfig.json, index.html
  electron/
    main.mjs              window, menu, IPC, protocols (vvapp, vvasset, vvfont), render manager, E2E hooks
    preload.cjs           window.vv API (the only bridge to the main process)
    assets/               bundled Jost (served to render windows as vvfont://)
    lib/
      project.mjs         Project class: create/open/mutate/import/remove/renders (serialised, atomic writes)
      fsx.mjs             safe names, containment, SHA-256, atomic JSON write (+ .bak)
      recent.mjs          recent projects (user-data folder)
      settings.mjs        app settings: FFmpeg location (user-data folder)
      render/
        clock.mjs         virtual clock, injected into the page before its scripts run
        session.mjs       offscreen render window: clock, fonts, hidden elements, frame capture
        job.mjs           frame loop -> encoder, progress, cancel, cleanup (no Electron imports)
        ffmpeg.mjs        find FFmpeg, encoder command, streaming PNG -> H.264
  shared/
    project-format.mjs    project schema, aspects, tracks, file kinds, render options (used by both sides)
  src/
    App.tsx, main.tsx, styles.css
    model/                types, display helpers
    panels/               StartScreen, ProjectBar, AssetLibrary, PreviewPanel (HTML player), TimelinePanel,
                          InspectorPanel (render section), NewProjectDialog, AboutDialog, StatusLine
  public/                 icon.svg, brand/vier-black.svg
  spikes/                 render-spike.mjs (feasibility, not part of the app)
  tests/
    fixtures/ftir-60s.html   default test file (the FTIR example)
    unit/                 Vitest: 48 tests (project format, file helpers, project lifecycle, recent list,
                          formatting, virtual clock, FFmpeg, render job, render records)
    e2e/stage1.mjs        Electron over CDP: 23 checks
    e2e/stage2.mjs        Electron over CDP with the FTIR file: 14 checks
    e2e/stage3.mjs        Electron over CDP with real narration: 14 checks
    fixtures/             ftir-60s.html (default test file), narration-sample.txt
  docs/PLAN.md            this file
```

**Project folder (user data, never inside the app):**
```
<Project>/
  project.vvproj.json       document: settings, folders, assets (incl. HTML render options), renders, timeline
  project.vvproj.json.bak   previous version, kept on every save
  assets/                   private copies named <sha16>-<name>.<ext>; originals are never touched
  renders/                  exported MP4s (<name>-<fps>fps-<timestamp>.mp4)
```

## 6. Phased plan

**Stage 1 — Foundation: done and tested** (see §7)

**Stage 2 — HTML rendering: done and tested (2026-11-17)**
- **Preview:** a frame-accurate player for HTML animations. Play, pause, stop, previous and next frame, scrubber, timecode. Each frame comes from the same engine as the export, so what you see at a time is what is exported at that time. Playback runs at the wall-clock rate when rendering keeps up, and skips frames when it does not.
- **Deterministic capture (default):** the clock is injected through DevTools before any page script runs. It replaces `requestAnimationFrame`, `performance.now`, `Date`, `setTimeout`/`setInterval`, seeds `Math.random`, and holds CSS/Web Animations at the requested time. Every frame is advanced to its exact time and then captured with `Page.captureScreenshot`.
- **Real-time capture (fallback):** the page runs normally and frames are taken at wall-clock times. Slow frames make the video run late. Warned in the UI.
- **Export:** H.264 yuv420p MP4 at the project's frame size, 30 or 60 fps, from the project settings. Written to `renders/` through a `.part` file, renamed when complete. Progress, cancel (partial file removed) and a record in the project.
- **Page elements:** `#controls, #bar` (the example's buttons and progress bar) are hidden by default. The selector list is editable per HTML asset.
- **Fonts:** Google Fonts requests in the render window are answered with the bundled Jost, so canvas text is identical on every machine.
- **FFmpeg:** found from settings, `VIERVIDEO_FFMPEG`, the packaged bundle, or PATH. Choosable in the Inspector. A missing or broken FFmpeg gives a message, not a crash.
- **Measured on this PC (headless):** a 60 s FTIR export (1,800 frames at 30 fps) takes about 195–215 s (about 9 fps). Two exports of the same animation are visually identical: 1,735 of 1,800 frames are byte-identical and the lowest frame is 54 dB PSNR. The few differing frames differ by rounding in the rasteriser.

**What was tried and dropped (so it is not repeated):**
- A "stall" at about frame 1,500 was not a render fault. The export test gave up after 150 s, but a 60 s export takes about 200 s. Window recycling, `capturePage`, and non-surface capture were tried against that stall and dropped. Non-surface capture also broke the preview.
- A layout viewport can shrink for a few frames during a long export (the page then draws at 30% width). Each capture now checks the viewport and restores it if needed.
- A plain hidden window: `Page.captureScreenshot` never returned. Offscreen rendering fixed that.
- `paint` events from the offscreen window: the bitmaps were intermittently 0 × 0. Screenshots are reliable.
- `Emulation.setDeviceMetricsOverride` on the offscreen view gave 0 × 0 paints. Removed.
- Attaching the debugger before any document exists hangs. The window loads `about:blank` first.
- FFmpeg cannot infer the container from a `.part` name. `-f mp4` is set.

**Stage 3 — TTS integration: done and tested (2026-11-17)**
- Built: a Python worker (`tools/tts/worker.py`, JSON lines) that uses the vier-tts venv and the Kokoro model cache, with the batch-6 synthesis logic (sentence-by-sentence, trim, fade) and batch-6's pronunciation rules ("Vier" → "veer", kept as in batch 6). The worker runs offline (`HF_HUB_OFFLINE=1`).
- Built: voice picker with the 8 voices of the pack, a preview for each, speed 0.70–1.30, and segments from timed scripts (`[0:05 - 0:12]`, SRT, VTT, JSON, CSV) or plain text.
- Built: per-segment text editing, regenerate for one segment, cache by text+voice+speed+synthesis version, and stale marks when voice or speed change. Narration clips appear on the timeline at their start times.
- Old text kept for reference (planned design):
- A Python worker (`tools/tts_worker.py`, JSON lines over stdin/stdout) that uses the batch-6 venv's Kokoro functions. The Python path comes from a setting or `VIERVIDEO_PYTHON`, with the venv folder as the default. No hard-coded path.
- **Voice picker** with the 8 voices in the pack, a preview button for each, and speed. The default is set by the user.
- **Pronunciation list** in VierVideo, including "Vier" → "veer".
- Parse TXT, Markdown, JSON, SRT/VTT and `[00:05 - 00:12] text` lines. Unstamped text is split into sentences and grouped.
- One WAV per segment, durations measured with `soundfile`, regenerate one segment, cache by text+voice+speed+pronunciation signature.
- Narration track on the timeline with each segment as an element.
- Risks: Python process lifecycle and cancel; `HF_HUB_OFFLINE=1`; first load of the model takes time.

**Stage 4 — Editing**
- Multitrack timeline: clips, drag, trim, split, delete, move between tracks, volume, fades, zoom. The timeline already has the five tracks and zoom.
- Overlay layers (text, shapes, images, SVG, logos) using the DCE Fabric code, selection on the canvas, inspector in the DCE style.
- Element overrides and hiding inside imported HTML (where the page exposes elements).
- Risk: the timeline is new code. Keep the data model pure and unit-tested.

**Stage 5 — Final render**
- Composite HTML frames with overlay layers per frame, mix narration with music and effects (`amix`, `loudnorm`, `afade`), encode with audio.
- Standalone HTML export.

**Stage 6 — Packaging** (only if distribution is ever wanted; currently private use)
- If shipped: check the FFmpeg licence (this build includes libx264, GPL) and the Kokoro/torch size first.

## 7. What has been verified

**Stage 1 (2026-11-17):** typecheck clean; 23 end-to-end checks pass against the built app, including creating and reopening projects, duplicate and unsupported imports, previews, folders, settings, path containment, remove, restart, missing files, damaged files. Screenshots reviewed at 9:16 and 16:9.

**Stage 2 (2026-11-17):**
- Unit tests: 48 pass. The virtual clock (frame timing, timer order, intervals, `Date`, seeded random, animation holding, self-contained injection), the encoder command, FFmpeg discovery, the render job with a fake session (frame count, progress, cancel leaves nothing behind, page error leaves nothing behind), render options and render records.
- End-to-end (`tests/e2e/stage2.mjs`, default 8 s): preview frame appears; frame stepping moves exactly one frame at 30 fps; scrubbing to 3 s shows 0:03.0; play runs in real time and pause holds; hidden-element default; export is H.264 yuv420p, 1080×1920, 30 fps, correct length; a second export is identical frame by frame; a real-time export has the right length; cancel removes the partial file; a bad FFmpeg location gives a message; renders and render options survive a restart.
- Regression: Stage 1 end-to-end still passes (the HTML check now looks for the rendered frame and the "never asked for an animation frame" warning, since the live iframe was replaced).

**Full-length run (FTIR, 60 s), final version:** export passes (about 200 s, correct length); repeatability passes (1,735 of 1,800 frames byte-identical; lowest frame 54 dB); real-time export, cancel, bad FFmpeg and restart pass. Stage 1 regression passes.

**Stage 3 (2026-11-17):** unit tests cover the parser (all formats), layout and timing warnings, signatures, the project narration fields, and the voice list against the Python config. `tests/e2e/stage3.mjs` (14 checks) runs real Kokoro synthesis through the app: voice list and preview, segments with timestamps, one WAV per segment, timeline clips at their start times, playback of a segment, edit and regenerate of one segment only, speed change marks segments stale, cancel, recovery, a bad Python location, and persistence after a restart.

**Not verified yet**
- Native file dialogs and drag-and-drop from Windows Explorer (tests replace dialogs; the drop path is untested).
- Animations that use `<video>`, Web Audio or `fetch` data beyond the example. Only the example and a non-animated page were rendered.
- Very large or stateful animations: the preview assumes frames can be drawn in any order, which holds for the example.
- Behaviour on a clean machine.

## 8. How to run

```powershell
cd VierVideo
npm install
npm test                 # unit tests (Vitest)
npm run build            # typecheck + bundle
npm start                # build and run the app
npm run e2e:stage1       # Stage 1 end-to-end (about a minute)
npm run e2e:stage2       # Stage 2 end-to-end with the FTIR file (8 s by default; VV_DURATION=60 for the full length, about 12 min)
npm run e2e:stage3       # Stage 3 narration with real Kokoro voices (needs the vier-tts venv; about 3 min)
npm run e2e:stage4       # Stage 4 timeline and layers with the FTIR file (about 4 min)
npm run e2e:stage5       # Stage 5 final render: narration and music mixed into the MP4 (needs the vier-tts venv; several minutes)
npm run dist:win         # Stage 6: build the Windows installer into %USERPROFILE%\VierVideo-release (a few minutes)
npm run e2e:installed    # Stage 6: install the built installer silently and test the installed program (about 2 min)
npm run e2e:usability    # Usability round: example project, zoom, full screen, taskbar, Edit element (code and studio) (about 3 min)
```

FFmpeg must be on PATH, or set `VIERVIDEO_FFMPEG` to `ffmpeg.exe`, or choose it in the Inspector.


## 9. Stage 4 — timeline and layers (2026-11-17)

Built and tested:
- **Timeline model** (`shared/timeline.mjs`, pure): clip kinds html, image, shape, text, audio; edit operations move (also between tracks of the same kind), trim, split, delete, update, add; validation; per-time layer state with fades. One HTML animation per project; layers may overlap and are drawn in track order. Narration clips are read-only here (they follow the script segments). A new clip is moved back so it fits inside the project.
- **Layers** are DOM elements in the render page (`electron/lib/render/composition.mjs`), above the HTML animation by default or behind it when marked. Preview and export use the same engine.
- **Editor**: timeline with drag to move (also between tracks), trim at either edge, split (S), delete (Delete), add text / box / circle / line / arrow / image / music / animation; playhead on the frame grid; inspector for placement, text, shape, fades, opacity and volume; click or drag layers in the preview.
- **Export** of the timeline as a silent MP4 (video only; audio mixing is the next step).

Verification:
- Unit: 92 tests across 5 files (timeline model: 23).
- End-to-end `tests/e2e/stage4.mjs`: 14 checks pass (add animation, refusal of a second one, text and placement, add shape at 2 s, mouse move, trim, split and delete, inspector fades and opacity, refused move to a wrong track, timeline export checked with ffprobe, persistence after restart).
- Regression on the current code: Stage 1 (23), Stage 2 with 8-second export (14), Stage 3 (14) pass.

Not verified: the 60-second full-length export was last run before the Stage 4 change to the render session (it passed then); music clips with real audio files are not in the end-to-end test; mixing of narration and music audio into the video is Stage 5.

## 10. Stage 5 — final render with narration and music (2026-11-17)

Built and tested:
- **Audio plan** (`shared/audiomix.mjs`, pure): each narration and music clip becomes one FFmpeg input, trimmed to its clip length, set to its volume, faded in and out, and delayed to its start time. The inputs are summed (`amix`), cut to the project length, and limited (`alimiter` at 0.95) so loud parts do not clip.
- **Mux** (`electron/lib/render/mux.mjs`): the video is rendered to a temporary `.video-*.mp4` and then copied, not re-encoded, into the final MP4 with AAC audio (192 kbps, 48 kHz, fast-start). The temporary file is removed afterwards. Video-only exports (no audio clips) are written directly, as before.
- **Refusals before any frame is drawn:** a narration segment that has no audio yet, or a music file that has been removed from the project, stops the export with a message that says what to do.
- **Status line** after export: `Exported timeline-…mp4 (N frames, sound from K clips).` The render record stores `audioClips`.

Verification:
- Unit: 99 tests across 6 files (audio plan 5, mux arguments 1, real FFmpeg mux 1).
- End-to-end `tests/e2e/stage5.mjs` (12 checks, about 3 minutes, real Kokoro speech): the FTIR animation on the HTML track; the sample narration generated from its timed script; a 100 Hz tone added as music and set to 15 s; export through the Export video button; the file is H.264 1080×1920 with one AAC track, 15.0 s long; the gap before segment 2 has no speech (about -67 dB in the speech band); speech starts at 4.0 s and 9.0 s (about -29 dB and -34 dB measured over 160 ms); the tone is present in the gap (about -24 dB at 0–150 Hz); the project, narration, animation and music survive a restart.

Lessons from testing:
- Put FFmpeg's `-ss`/`-t` before `-i` when measuring a time window. With the seek after `-i`, this build reads the same level for every window, which made a silent span read -34 dB instead of -91 dB.
- AAC encoding did not smear the start of a sound into the silence before it (checked with a synthetic burst encoded the same way), so the sync windows can sit close to the onset.

Not verified:
- Speech that is longer than its segment slot: the mix cuts it at the slot end, which is by design, but the case has not been tested with a real voice.
- Export at 60 fps with sound, and a 60-second project with sound.
- Music volume and fades in the final file: they are covered by the plan unit tests and the real-FFmpeg mux test, not by the end-to-end run.
- The tone check is a level check in the gap, not a frequency match against the original tone file.

Regression after Stage 5 (same code, run in sequence): Stage 1 passes 23 of 23; Stage 2 with an 8-second export passes 14 of 14 (175 of 240 frames byte-identical on the repeat, lowest frame PSNR 54.1 dB); Stage 3 passes 14 of 14 with real Kokoro voices; Stage 4 passes 14 of 14. The 60-second FTIR re-run that was pending since Stage 4 also passes: export about 173 s, correct length, 1,735 of 1,800 frames identical on the repeat (lowest PSNR 53.7 dB), real-time export, cancel and restart all pass.

Known cosmetic issue: the Stage 2 test step label says "set the project to 8 s" even when `VV_DURATION=60` is set. The duration itself is correct.

## 11. Stage 6 — Windows installer (2026-11-17)

Built and tested:
- **Installer:** electron-builder 26 (NSIS, x64), installs per user without administrator rights, asks for the folder, creates Start menu and desktop shortcuts, and uninstalls silently. Output: `VierVideo-Setup-0.1.0.exe` (176 MB), in `%USERPROFILE%\VierVideo-release`, outside OneDrive (`VV_OUT` overrides).
- **Build:** `npm run dist:win` (`scripts/dist-win.mjs`) typechecks and bundles the app, stages FFmpeg (`ffmpeg.exe` from `VV_FFMPEG_SOURCE`, or else from PATH), writes a notice with its version and license, then runs electron-builder with the `build` section of `package.json`. The generated configuration uses absolute paths, so the repository holds none.
- **FFmpeg:** shipped as `resources\ffmpeg\ffmpeg.exe`. The app uses it when no FFmpeg is set in the settings or `VIERVIDEO_FFMPEG`. This build is GPL (`--enable-gpl`), accepted because the app is not distributed.
- **Narration files:** `resources\tts` holds `worker.py`, `config.json`, `pronunciations.json`, `requirements.txt` and `setup-narration.ps1`. Fixed in this stage: the worker used a path relative to the app's source folder, which inside the packaged app is `app.asar`, a file Python cannot read. `electron/lib/paths.mjs` now picks the right folder in each case.
- **Narration engine is optional** and not in the installer (Python plus Kokoro is about 1 GB). `setup-narration.ps1` finds Python 3.10 to 3.12, creates `%LOCALAPPDATA%\vier-tts\venv`, installs `requirements.txt` (kokoro 0.9.4, numpy 2.5.4, soundfile 0.14.0, torch 2.15.0, huggingface_hub 2.3.0), downloads Kokoro-82M (about 0.4 GB) into `hf-cache`, and synthesises a test sentence. `-VerifyOnly` checks an existing install. The narration panel and the status line name the script when the engine is missing.
- **Icon:** `build/icon.ico` and `build/icon.png` are rendered from the VierApparatus `public/icon.svg` by `scripts/make-icons.mjs`, using the Microsoft Edge that Windows already has.

Verification:
- Unit: 101 tests across 7 files (2 new: narration file locations in development and once packaged).
- `setup-narration.ps1`: parses; `-VerifyOnly` against the existing venv synthesises a sentence (exit 0).
- End-to-end `tests/e2e/installed.mjs` (9 checks, against the installed program): silent install to a temporary folder; required files present; Start menu shortcut created; the program starts with PATH set to the Windows folders only and an empty LOCALAPPDATA; FFmpeg source is `bundled` and inside the install folder; the narration engine is reported missing without a crash; a 2 s export with the FTIR animation writes an H.264 1080×1920 file of 2.0 s; the narration panel names `setup-narration.ps1`; the silent uninstall removes the program and its shortcut.
- Regression after the narration path change: Stage 1 (23 of 23), Stage 3 (14 of 14, real Kokoro) and Stage 5 (12 of 12, real Kokoro with sound) all pass. Stage 5 measures are unchanged: gap -67 dB, onsets -29 dB and -34 dB, tone -24 dB.

Not verified:
- A clean Windows machine. The installed-program test simulates one (PATH and LOCALAPPDATA), but this PC still has Windows' own tools and Edge.
- A full narration install from scratch with `setup-narration.ps1`: that downloads about 1 GB. Only `-VerifyOnly` ran here.
- Upgrade over an older install, per-machine install, and the desktop shortcut (the test does not assert it, because OneDrive may redirect the Desktop folder).
- Code signing: none. Windows SmartScreen will warn on the unsigned installer.
- Size: 176 MB, because the FFmpeg is the full build (227 MB executable). A smaller FFmpeg build would make a smaller installer.

## 12. Usability round — feedback on the installed build (2026-11-18)

The first use of the installed program raised these points. Each one is addressed below.

- **Example project opens by itself.** On the first start (not in tests, unless `VV_AUTO_EXAMPLE=1`) the app creates "Example - FTIR spectroscopy" in `%USERPROFILE%\VierVideo` (not OneDrive, which locks files while it syncs) and opens it. The start screen's "Open the example" button opens it again, and the example is never copied twice. It is 9:16, 60 s, 30 fps, with: the FTIR animation on the HTML track; a chime at 0 s and a drone under the whole example (both generated in code, no sound file shipped); the narration script as three timed segments, whose audio is made once the narration engine is ready; a caption and the VierApparatus logo. `electron/lib/example.mjs`, `electron/lib/samples.mjs`.
- **Preview zoom and pan** (`src/panels/ZoomStage.tsx`). Ctrl + wheel, or the touchpad pinch, zooms around the pointer. The wheel or a two-finger scroll pans. The middle button, Space + drag, or dragging the grey area pans. Fit, 100% (real pixels), +/− are on the preview. Double-click on the grey area returns to Fit. Layers are still picked and moved at any zoom. The page itself no longer zooms with Ctrl + wheel.
- **Full screen.** F11 toggles it, Escape leaves it, the View menu has "Full screen (F11)", and an "Exit full screen" button shows while the window is full screen.
- **The stray "FTIR" window.** It was the render window (a real top-level window, shown in the taskbar). Three things were tried and did not work: an offscreen window shown with `showInactive` (still a visible native window); moving it to x = −32000 (still visible to Windows); making it an owned child of the main window (it took keyboard focus, so F11 and Escape stopped working). The fix: the render window is **never shown**, with `paintWhenInitiallyHidden: true`, `skipTaskbar`, and `focusable: false`. Frames still capture correctly. The check is the taskbar rule itself (a visible top-level window, not owned, not a tool window), read through Win32 for this process only.
- **Edit element** (right-click the preview). The menu has "Show code in the inspector" and "Open studio".
  - *Code.* The animation's HTML is editable in the right panel. Save (button or Ctrl+S) changes the copy inside the project. The first save keeps the imported copy, and "Restore original" puts it back. The file the user imported is never changed. Save reloads the preview.
  - *Studio.* A full-window editor over the same engine: zoom and pan, the add tools (text, box, circle, line, arrow, image), the layer inspector, and clicking the animation to see the element under the pointer (tag, id, classes, text, size, and its path). Escape closes it. Timing stays on the timeline.
  - Limits: the studio reads elements but does not restyle them (style changes are made in the code). Elements are found in the animation's own page, not in the composition layers.

Verification:
- Unit: 116 tests across 8 files (new: example project, samples, paths, code save and restore).
- End-to-end `tests/e2e/usability.mjs` (12 checks, `npm run e2e:usability`): example opens; contents; zoom, pan, Fit, 100%; a layer picked after zooming; F11 and Escape with **real Windows key presses** (keys sent over the DevTools protocol do not reach the app's key handling in this build); taskbar check; Edit element menu; code save to disk; studio element and box; restart with the saved code; Restore original.
- Regression, after the render-window change: Stage 1 (23), Stage 2 (14), Stage 3 (14, real Kokoro), Stage 4 (14), Stage 5 (12, real Kokoro with sound) all pass. Typecheck clean.
- Installer rebuilt and the installed-program test (9 checks, plus the example files) passes.

Not verified:
- The example's narration audio on a machine with the engine installed (the code path exists; the test checks the three segments, not the generated speech).
- The chime and drone sound quality, which has been checked only by the test that writes them, not by listening.
- F11 and Escape in the installed build (the usability test uses the development build; the installed test does not press keys).
- The studio on a 16:9 or 1:1 project (only 9:16 was tested).

Decisions to confirm:
- The FTIR animation is included in the installer by default, for your own use (you said you will not distribute it). Build with `VV_NO_EXAMPLE_ANIMATION=1` to leave it out; the example then cannot be created in the installed program.
- The example lives in `%USERPROFILE%\VierVideo`, not in Documents, so OneDrive does not sync it.

## 13. Feedback round 7 — timeline, sound, elements, developer tools (2026-11-18)

Built and tested (`tests/e2e/feedback7.mjs`, 9 checks, all pass; `tests/e2e/usability.mjs` 12/12; Stages 1–5 and the installed-program test pass after the changes; unit tests 119/119):
- **Clips move freely.** A clip is no longer pinned to the project: any clip can move (a full-length one too) and may run past the end. Export and preview stop at the end. Trimming reaches past the end (safety limit 1 hour).
- **Overlapping clips stack in rows**, so no clip hides another. The timeline widens to its last clip. A **Fit** button zooms the whole timeline into view.
- **Narration clips move.** Moving one sets its segment's start time (the script time); the audio is unchanged. Narration cannot be trimmed, because its length is the audio's. Regenerating segments from the script resets their starts to the script times.
- **Sound in the preview.** Play mixes the timeline's audio (the export's mix, `shared/audiomix.mjs`) into one WAV in `audio/`, which plays with the frames; pause, stop and seek follow it. The mix is cached by content and older previews are removed.
- **Developer tools for the animation** (View menu). The animation opens in its own window (live, not frame-by-frame) with the tools docked. The old item still opens the app's own tools.
- **Elements of the animation move in the studio.** A press finds the element; dragging it saves an offset (CSS `translate`, a property separate from the animation's own transform) in the project. Preview and export apply it the same way. Reset removes it.
- **Code for the selected element** (studio). The lines that name its id (or its first class) in the animation's code, with four lines before and nine after. If the script builds the element, no line names it, so the live HTML is shown.
- **Narration starts by itself at first start** (the example) when the engine is installed.

Bugs found and fixed in this round:
- The preview's sound file was written outside `audio/`, so the player could not find it.
- The sound mix's inputs were numbered one place off, and the mix was not padded to the project's length (it stopped at its longest clip, which also affected the export's sound).
- Media files need HTTP byte-range requests for the player; the project-file protocol now answers them.
- Render-option saves dropped the element offsets.
- Autoplay of the program's own audio is allowed (`autoplay-policy`), since the mix can take longer than a click's user gesture.

Not verified:
- SVG elements: the offset is in frame pixels, but an SVG child inside a scaled viewBox may move by a different amount.
- Element moves are keyed by the element's path. If the animation's DOM structure changes, a stored offset may stop matching.
- 16:9 and 1:1 projects in the studio.
- The rebuilt installer was checked for the old features; the new ones were checked in the development build.

## 14. Feedback round 8 — layers in the studio (2026-11-18)

Built and tested in the development build (`tests/e2e/layers8.mjs`, 9 checks, all pass; unit tests 135/135 in 10 files; `tsc --noEmit` clean):
- **Selection rectangle.** A drag that starts on empty space, or on the whole canvas, draws a dashed rectangle and selects the visible layers it touches. Shift keeps the earlier selection. A drag that starts on a small element of the animation still moves that element.
- **Groups.** A group is a shared `group` id on its layers (`groupClips`, `ungroupClips`). A click on a grouped layer selects the whole group; Shift-click adds or removes it (`pickIds`, `groupMembers`). Group and Ungroup are in the selection panel; Ctrl+G and Ctrl+Shift+G do the same. Groups are one level deep.
- **Move and resize together.** Dragging a selected layer moves the whole selection (`shiftLayers`). The four corner handles resize it (`scaleLayers`, `scaledRect`): the opposite corner stays put, each layer keeps its place inside the box, text grows with the box's height, and a box is never under 4 px.
- **HTML elements as layers.** The studio's Element dialog takes one element's HTML (pasted or read from a file) and adds it as a layer at the playhead (kind `snippet`). The animation and its code are not changed. `sanitizeSnippet` removes comments, scripts, frames, plugins, event attributes and `javascript:` addresses. The layer is drawn in a shadow root, so its styles stay inside it. Its HTML can be edited in the inspector.
- **Rulers, grid and snapping** (added in this round's session): rulers and a grid over the frame, 10 to 100 px; moves snap the selection's top-left corner, resizes snap the moved corner.
- **Layer list** (added in this round's session): layers at the playhead, top first, with bring forward and send backward; grouped layers are marked.
- **Master prompt** (a top-level "Master prompt" menu, beside File, Edit, View and Help; Show and Copy): `electron/assets/master-prompt.md` describes how the app works (picking, snapping, groups, the element layers, the sound, the export). It is a description, not a list of commands.

Also in this session, before round 8 (not in §13): parts of a canvas-drawn animation can be picked and moved one by one ("option 1", `electron/lib/render/canvas-recorder.mjs`), and the animation's whole-canvas element is not moved.

Regression, after all of the above:
- `tests/e2e/feedback7.mjs` 9/9; `tests/e2e/parts7.mjs` passes; `tests/e2e/stage1.mjs` to `stage5.mjs` each exit 0.
- `tests/e2e/usability.mjs` 12/12 when run alone. In the batch run its full-screen step (F11 then Escape, real Windows key presses) timed out once and passed on the next run. The step needs the app to hold focus, so the cause is probably focus, not the change; this is not proven.
- `tests/e2e/installed.mjs` was not run (it changes the Start menu and closes running copies; it needs the user's approval).

Installer: rebuilt with `node scripts/dist-win.mjs` as `%USERPROFILE%\VierVideo-release\VierVideo-Setup-0.1.0.exe` (184 MB, unsigned), after the changes above.

Not verified:
- The installed program with these features: the installer was built, but it was not installed and tested.
- Export of a snippet layer: the e2e test checks that the preview frame changes, not the exported pixels.
- Snippets with CSS animations: they run in real time, not on the timeline clock, so they are not deterministic. The studio warns about this; nothing enforces it.
- Shift-click, Ctrl+G and the keyboard shortcuts are not covered by the e2e test; the grouping and handles are.
- 16:9 and 1:1 projects in the studio.

## 15. Feedback round 9 — a moved part moved other parts (2026-11-18)

**What happened.** A move of one part of a canvas-drawn animation (the wave in the "Every molecule" scene) also moved a part of another scene (the spring of the "Stretching" scene, from 6 s on).

**Why.** The studio stored a canvas part's move by its paint call's number within a frame (`opOffsets`, `index`). The number is only meaningful inside one scene: the FTIR animation draws each scene with its own paint calls, and the same number is a different paint call in another scene. The saved moves in the example project were exactly that: eight bare numbers, no record of what they were. Applied to every frame, the move of stroke #1 in one scene moved stroke #1 of the next scene too. `tests/e2e/scenes9.mjs` reproduced it on the previous build: one move changed 55 other parts, from 0 s and again from 6 s.

**The fix.**
- Each paint call has a `key`: its kind, its colour without transparency (so a fade does not change it), and its text (`electron/lib/render/canvas-recorder.mjs`).
- A move is stored with that key and with the stretch of the video where the part is the same part: `t0` to `t1`, in seconds. `partWindow` (`electron/main.mjs`) finds the stretch when the part is picked: it walks the frames around the pick one second at a time, while the paint call with the same number and key stays where it was (its box moves by less than its own size and 80 px between samples), then halves in on each edge to the frame.
- `activeOpOffsets` (`shared/project-format.mjs`) sends to the render page only the moves whose stretch contains the time. The preview and the export use the same frame state, so they agree.
- Moves saved before this round have no key and no stretch. They are dropped by `normalizeRenderOptions`, so they cannot be attributed to a part; the example project keeps its old entries in the file, but they no longer apply.
- DOM element moves are now kept with the element's tag and id. An element at the same path that is a different element is not moved (`electron/lib/render/composition.mjs`).

**Tests.**
- Unit: 141 of 141 (`tests/unit/render-parts.test.ts`: keys, stretches, legacy entries dropped; `tests/unit/canvas-recorder.test.ts`: keys with a fade, offsets by number).
- New end-to-end test `tests/e2e/scenes9.mjs`: imports the FTIR file from Downloads into a new project through the UI, moves the wave by 120 px in its own scene, then compares every second of the video with the state before the move. Only the wave differs, and its move ends at the scene boundary (about 6 s). Passes.
- `tests/e2e/parts7.mjs` (option 1, the letter C), `tests/e2e/layers8.mjs`, `tests/e2e/feedback7.mjs`, `tests/e2e/usability.mjs` (12/12) and `tests/e2e/stage5.mjs` all pass.
- `tests/e2e/scenes9.mjs` failed once with "target closed" on the first run after a build, and passed on the next runs. The cause is not known. Recheck it if it returns.

**Limits, stated plainly.**
- A part that moves faster than its own size and 80 px a second is not followed from frame to frame, so its move ends early. Slow and steady motion, like the wave, is followed.
- Two parts in one scene with the same number, key and place in consecutive frames cannot be told apart and move together. Different scenes are separated by their stretches, so the case in this report cannot happen again.
- A scene that ends and later starts again with the same part is two stretches. A move made in the first stretch does not carry to the second.
- The FTIR file from Downloads was imported fresh into a new test project, not into the user's example project. The example project's old moves are inert but still in its file.

## 16. Feedback round 10 — canvas parts, drag, group, master prompt (2026-11-18)

**What was reported.** A drag of the FTIR title went further left than the pointer; a rectangle on empty space selected nothing that the user could group or move; Ctrl+G did not group; the master prompt was a long description of the app, when the user needed a brief that tells an AI how to write HTML the studio can work with.

**Why.**
- Text boxes assumed left alignment and top baseline. The FTIR title is centred, so its box started at the centre and ran right: presses on the visible left half missed it, and the box and the ghost sat half a text-width off.
- Snapping rounded every drag to the grid, so a drag could land up to half a grid cell from where the pointer went.
- The marquee and the groups only handled timeline layers. The title and the wave are canvas parts, not layers, so they could not be selected by the rectangle, grouped, or moved as a group.

**What changed.**
- `electron/lib/render/canvas-recorder.mjs`: text boxes come from the browser's measured text bounds for the current alignment and baseline. Each part has a transform: moved and scaled (`sx`, `sy`, `dx`, `dy`). Path points, rectangles, images and arcs scale; text draws scaled about its anchor, so it stays inside its box; a stroke's width scales by the square root of the area factor.
- `shared/project-format.mjs`: moves keep their scale and offset; `composePartOffsets` composes a new transform onto the one already saved for the same part in the same stretch of the video; `partGroups` records which parts belong to a group, with their stretch.
- `shared/timeline.mjs`: `tagClips` (groups any number of clips), `expandGroups` (a selection, completed across layers and parts).
- `src/panels/CompositionPreview.tsx`: the selection holds layers and parts. A marquee selects both. A press on a part selects it with its group, and a drag moves the selection. Corner handles resize the selection, including parts. Snapping engages only within 6 screen pixels of a grid line.
- `src/App.tsx`, `src/panels/Studio.tsx`: group and ungroup work on layers and parts together; the parts list shows selection and group membership.
- `electron/main.mjs`: `e2e:ops` and the render-options save go through the preview queue. Saving an option used to close the shared render page while a frame was being drawn, which failed that frame.
- Master prompt (`electron/assets/master-prompt.md`): now a short brief for an AI that writes the HTML: how the app reads it, size and time, text, shapes and drawings, what must not happen, and a checklist. The long description is kept as `docs/how-the-app-works.md`.

**Tests.**
- Unit: 160 of 160 pass (new: `tests/unit/part-groups.test.ts`, `tests/unit/canvas-scale.test.ts`, text box and recorder cases in `tests/unit/canvas-recorder.test.ts`, render-parts updates).
- End-to-end, all against the real app with the FTIR file from Downloads imported into a new project: `groups10.mjs` (new: the left half of the title picks it; a marquee selects the title and the wave; Ctrl+G, a real key press, groups them; a 60 px move moves both; a corner handle resizes both; a snapped drag follows the pointer), `scenes9.mjs`, `parts7.mjs`, `layers8.mjs`, `feedback7.mjs`, `stage5.mjs` pass.
- `usability.mjs` passes 12/12 when run alone. In the batch runs it failed at the full-screen step (F11 then Escape with real key presses), in both batch runs. The step depends on focus, and I have not found the cause.

**Limits.**
- Parts scale exactly for canvases without rotation or skew; the FTIR has none.
- A part that moves faster than its own size and 80 px a second is not followed from frame to frame; its group or move ends early.
- Snapping takes an edge only within 6 screen pixels of a grid line, so a drag is exact except within that pull.
- A group of parts is kept per stretch of the video: a group made at one time is not extended to another stretch of the same part.
- The installed program was rebuilt (`VierVideo-Setup-0.1.0.exe`, 176 MB, unsigned) but not installed or tested.

## 17. Feedback round 11 — a moved part stayed in its own scene (2026-11-18)

**What was reported.** Moving the Stretching spring also moved the Bending springs.

**Why.** A part's stretch of the video was found by walking frames around the pick while the paint call kept its number, kind, colour and text, and stayed within its own size plus 80 px. The Bending scene draws its spring as paint call 1, a dark stroke, about 130 px from the Stretching spring, so the walk carried the move across the cut and kept going until call 1 changed (10 s to 14 s). The HTML draws the same spring object in both scenes, so the app could not tell a continuing spring from a new one by position alone.

**What changed.**
- `sameScene` (`shared/project-format.mjs`): two frames are the same scene when at least 60% of the earlier frame's parts (by kind, colour and text) are still drawn in the later one. A cut changes most parts at once.
- `partWindow` (`electron/main.mjs`): a stretch ends at a scene cut, both in the walk and when the edge is found.
- `vvScene(name)` (`electron/lib/render/canvas-recorder.mjs`): the animation can name its scenes. The name is part of each paint call's key, so parts of one scene are never the same part as parts of another.
- Master prompt: a new section on scenes (name each scene, never reuse or morph an object across scenes, clear what a scene no longer shows, element ids unique across the whole document), and two checklist items.

**Tests.**
- Unit: 166 of 166 pass (new `tests/unit/scenes.test.ts`: the scene test, and the scene name in the recorder keys).
- End-to-end: `tests/e2e/scenes11.mjs` (new) moves the Stretching spring at 7 s. The saved stretch is 6.03 s to 9.97 s, which ends at the cut, and no other part moves at any of the 60 seconds, including the Bending springs. `parts7`, `groups10` and `scenes9` also pass.

**Limits.**
- An HTML element's move (not a canvas part) applies wherever its id and tag are in the page, at any time. The master prompt's rule (unique ids across the whole animation) covers this. The app does not yet give element moves their own stretch.
- The stretch test is by position and by the scene test. A cut that changes fewer than 40% of the parts will not be seen as a cut.
- Moves saved before this round keep their old stretch. In your example project, the spring's saved stretch is still 6.03 s to 14 s, so it still reaches into the Bending scene until it is reset.
- The installer was rebuilt (`VierVideo-Setup-0.1.0.exe`), not installed or tested.
