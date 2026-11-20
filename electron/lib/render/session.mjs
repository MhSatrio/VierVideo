// A render session: one offscreen Electron window that shows one HTML animation at the output size.
// Deterministic mode injects the virtual clock (through DevTools) before any page script runs, then advances
// it for every frame and takes a DevTools screenshot. Real-time mode runs the page normally and only screenshots.
// Offscreen windows keep a compositor surface while hidden. Paint events were tried first and gave empty
// bitmaps intermittently, so they are not used.
// The window has no preload and no IPC: the HTML is treated as untrusted content.
import { BrowserWindow, session as electronSession } from 'electron';
import { randomBytes } from 'node:crypto';
import { clockSource } from './clock.mjs';
import { installComposition } from './composition.mjs';
import { installCanvasRecorder } from './canvas-recorder.mjs';

const EPOCH_MS = Date.UTC(2026, 0, 1);
const DEBUG = process.env.VV_DEBUG === '1';
const log = (...a) => {
  if (DEBUG) console.error('[render]', ...a);
};
const FONT_CSS_HOST = 'https://fonts.googleapis.com/';
const SHOT_TIMEOUT_MS = 20000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Width and height from the IHDR chunk of a PNG. */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('The render produced something that is not a PNG.');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * @param {object} o
 * @param {string} o.url                    vvasset:// address of the HTML asset
 * @param {number} o.width
 * @param {number} o.height
 * @param {'deterministic'|'realtime'} o.mode
 * @param {string} [o.hideSelectors]        CSS selectors hidden in the rendered frames
 * @param {{asset: Function, font: Function}} o.handlers  protocol handlers for vvasset:// and vvfont://
 */
export async function openRenderSession(o) {
  const partition = 'render-' + randomBytes(6).toString('hex'); // in-memory: nothing persists
  const ses = electronSession.fromPartition(partition);
  ses.protocol.handle('vvasset', o.handlers.asset);
  ses.protocol.handle('vvfont', o.handlers.font);
  // Google Fonts is replaced by the bundled Jost, so the same text is drawn on every machine.
  ses.webRequest.onBeforeRequest({ urls: [FONT_CSS_HOST + '*'] }, (details, callback) => {
    callback({ redirectURL: 'vvfont://css/fonts.css' });
  });

  const win = new BrowserWindow({
    width: o.width,
    height: o.height,
    useContentSize: true,
    show: false,
    // This window only draws frames. It is never shown, so it cannot appear in the taskbar or take focus from the editor.
    // paintWhenInitiallyHidden lets the page lay out and paint without the window being shown.
    paintWhenInitiallyHidden: true,
    skipTaskbar: true,
    focusable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      session: ses,
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      webSecurity: true,
    },
  });
  win.setContentSize(o.width, o.height);
  win.setSkipTaskbar(true);
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, target) => {
    if (target !== o.url) event.preventDefault();
  });

  const warnings = [];
  // A session without a URL is a blank page for layers alone: there is no animation to drive.
  const deterministic = o.url ? o.mode !== 'realtime' : false;
  const cdp = (method, params) => wc.debugger.sendCommand(method, params);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      wc.debugger.detach();
    } catch {
      /* not attached */
    }
    if (!win.isDestroyed()) win.destroy();
  };

  const shot = async () => {
    const r = await withTimeout(
      cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
      SHOT_TIMEOUT_MS,
      'The page did not produce a frame. The animation may be stuck or too heavy for this computer.',
    );
    return Buffer.from(r.data, 'base64');
  };

  try {
    // A document must exist before the DevTools session can attach.
    await wc.loadURL('about:blank');
    wc.debugger.attach('1.3');
    await cdp('Page.enable');
    if (deterministic) {
      await cdp('Page.addScriptToEvaluateOnNewDocument', { source: clockSource({ epoch: EPOCH_MS, seed: 1 }) });
    }
    if (o.url) {
      log('loading', o.url);
      await wc.loadURL(o.url);
    }

    // Warm-up in real time. The clock has not moved yet, so an animation that starts on load begins at t = 0.
    await wc.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true);
    if (o.hideSelectors) {
      await wc.executeJavaScript(
        `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(o.hideSelectors + ' { display: none !important; }')}; document.head.appendChild(s); return true; })()`,
        true,
      );
    }
    if (o.composition) {
      await wc.executeJavaScript('(' + installComposition.toString() + ')(window, ' + JSON.stringify(o.composition) + ')', true);
      // The parts of a canvas-drawn animation (see canvas-recorder.mjs): recorded, and moved by offsets when drawn.
      await wc.executeJavaScript('(' + installCanvasRecorder.toString() + ')(window)', true);
    }
    if (deterministic) {
      const started = await waitFor(async () => (await wc.executeJavaScript('window.__vvClock.registered()', true)) > 0, 4000);
      if (!started) warnings.push('The animation never asked for an animation frame. Frames are drawn at t = 0 only, so the motion may be missing.');
    }
    // The frames must have the output size before any export starts.
    const probe = pngSize(await shot());
    log('frame size', probe.width, probe.height);
    if (probe.width !== o.width || probe.height !== o.height) {
      throw new Error(`The render window produces ${probe.width} × ${probe.height} frames, not ${o.width} × ${o.height}.`);
    }
  } catch (err) {
    await close();
    throw err;
  }

  // One frame at a time, in order, so a preview request never interleaves with an export frame.
  let chain = Promise.resolve();
  // state (optional): the layers of the composition for this frame, drawn by installComposition.
  const frame = (ms, state) => {
    const next = chain.then(async () => {
      if (closed) throw new Error('The render window was closed.');
      // The layout viewport must be exactly the frame size. In a long export it was seen to shrink for a few
      // frames (the page then drew at 30 % width), so the size is checked before every capture and corrected.
      for (let attempt = 0; attempt < 4; attempt++) {
        // The parts of the frame: a new list, with the offsets that move parts of the animation (applied while drawing).
        await wc.executeJavaScript('window.__vvOpsBegin && window.__vvOpsBegin(' + JSON.stringify((state && state.opOffsets) || []) + ')', true);
        if (deterministic) await wc.executeJavaScript(`window.__vvClock.advance(${Number(ms)})`, true);
        if (state) await wc.executeJavaScript('window.__vvComp.render(' + JSON.stringify(state) + ')', true);
        const vp = await wc.executeJavaScript('[window.innerWidth, window.innerHeight]', true);
        if (vp[0] === o.width && vp[1] === o.height) return shot();
        log('viewport drifted to', vp.join('x'), 'at', ms, 'ms; restoring', o.width, 'x', o.height);
        win.setContentSize(o.width, o.height);
        await new Promise((r) => setTimeout(r, 60));
      }
      throw new Error(`The render window would not keep a ${o.width} × ${o.height} viewport.`);
    });
    chain = next.catch(() => {});
    return next;
  };

  // Which element of the animation is under (x, y), in frame pixels, at the time of the last frame drawn.
  // It runs after any frame in progress, so the page is in the state that the preview shows.
  // A part of the animation (a paint call) under the point wins; otherwise the DOM element under it.
  const inspect = (x, y) => {
    const next = chain.then(async () => {
      if (closed) throw new Error('The render window was closed.');
      const part = await wc.executeJavaScript(`window.__vvOpsPick ? window.__vvOpsPick(${Number(x)}, ${Number(y)}) : null`, true);
      if (part) return partInfo(part);
      return wc.executeJavaScript(`(${inspectPage.toString()})(${Number(x)}, ${Number(y)})`, true);
    });
    chain = next.catch(() => {});
    return next;
  };

  // The paint calls of the last frame drawn (for tests and for listing the parts).
  const ops = () => {
    const next = chain.then(() => wc.executeJavaScript('window.__vvOpsList ? window.__vvOpsList() : []', true));
    chain = next.catch(() => {});
    return next;
  };

  return { frame, inspect, ops, close, warnings, deterministic };
}

/** A part of the animation (a paint call), described as an element would be: its kind, its text or colour, its box. */
function partInfo(part) {
  const [x0, y0, x1, y1] = part.bbox;
  return {
    tag: part.kind,
    id: '',
    classes: [],
    text: part.text ?? '',
    html: '',
    selector: `canvas part ${part.index}`,
    rect: { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) },
    op: { index: part.index, kind: part.kind, text: part.text ?? '', color: part.color ?? '', key: part.key ?? '' },
  };
}

/** Runs inside the render page (so it must not use anything from this file). Returns the animation element at (x, y). */
function inspectPage(x, y) {
  // The composition layers are drawn on top; hide them while looking, so the animation underneath is found.
  const roots = Array.from(document.querySelectorAll('[data-vv-root]'));
  const saved = roots.map((r) => r.style.visibility);
  roots.forEach((r) => {
    r.style.visibility = 'hidden';
  });
  let el = null;
  try {
    el = document.elementFromPoint(x, y);
  } finally {
    roots.forEach((r, i) => {
      r.style.visibility = saved[i];
    });
  }
  if (!el || el === document.documentElement || el === document.body) return null;
  const pathOf = (node) => {
    const parts = [];
    for (let n = node; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      let part = n.tagName.toLowerCase();
      if (n.id) part += '#' + n.id;
      else if (n.classList.length) part += '.' + Array.from(n.classList).slice(0, 2).join('.');
      const sameTag = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [];
      if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(n) + 1) + ')';
      parts.unshift(part);
      if (n.id) break;
    }
    return parts.join(' > ');
  };
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    classes: Array.from(el.classList).slice(0, 8),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    html: (el.outerHTML || '').slice(0, 1500),
    selector: pathOf(el),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
  };
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
