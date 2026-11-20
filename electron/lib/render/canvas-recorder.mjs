// Canvas recorder: makes the parts of an animation drawn on a canvas selectable, movable and resizable.
//
// An animation that draws on a canvas (the FTIR example does: its circles, spring and letters are pixels on one canvas)
// has no separate elements. This records every paint call of the canvas during a frame (its kind, its text or colour,
// and its box in frame pixels), so the studio can pick one. A part is changed by a transform in frame pixels: a point
// (x, y) of the part goes to (sx * x + dx, sy * y + dy). The transform is applied when the part is made (its path points,
// its text position, its rectangle, its image), so the preview and the export draw the changed part the same way.
//
// The paint calls are numbered in the order they are made within a frame. The number is only meaningful within one scene:
// another scene draws other paint calls under the same numbers. So each paint call also has a `key` (its kind, colour and
// text), and a change is kept with its key and the stretch of the video where that part is the same part (see
// shared/project-format.mjs, and partWindow in electron/main.mjs). The numbering is the same from frame to frame within
// a scene as long as the animation draws the same sequence each time (it is checked in the tests, not guaranteed).
//
// What is changed, and what is not: a part scales its points, rectangles, images and arcs; a text part scales its font
// size by the square root of sx * sy; a stroke scales its line width the same way. This is exact for canvases without
// rotation or skew (the FTIR example has none).
//
// installCanvasRecorder runs INSIDE the render page, so it must not use anything from this file.
export function installCanvasRecorder(g) {
  const proto = g.CanvasRenderingContext2D && g.CanvasRenderingContext2D.prototype;
  if (!proto || proto.__vvRecorded) return false;
  proto.__vvRecorded = true;

  const rec = { list: [], index: 0, offsets: new Map(), frameW: 0, frameH: 0, scene: '' };
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

  // The animation names its scenes: `vvScene('stretching')` before a scene draws. The name is part of each paint call's
  // identity, so a part of one scene is never taken for a part of the next one (see the master prompt).
  g.vvScene = (name) => {
    rec.scene = String(name ?? '').replace(/[\u0000-\u001f|]/g, '').slice(0, 40);
  };

  // Called by the render session before each frame is drawn: starts a new list and sets the transforms to apply.
  g.__vvOpsBegin = (offsets) => {
    rec.list = [];
    rec.index = 0;
    rec.scene = '';
    rec.offsets = new Map(
      (offsets || []).map((o) => [Number(o.index), { sx: num(o.sx, 1), sy: num(o.sy, 1), dx: num(o.dx, 0), dy: num(o.dy, 0) }]),
    );
  };
  g.__vvOpsList = () => rec.list.map((o) => ({ ...o }));

  // The part under (x, y), in frame pixels: the topmost paint call whose box holds the point. A paint call that covers
  // (almost) the whole frame is the background, which is not picked (it cannot be moved part by part).
  g.__vvOpsPick = (x, y) => {
    const area = (rec.frameW || 1) * (rec.frameH || 1);
    for (let i = rec.list.length - 1; i >= 0; i--) {
      const o = rec.list[i];
      if (!o.bbox) continue;
      const [x0, y0, x1, y1] = o.bbox;
      if ((x1 - x0) * (y1 - y0) >= area * 0.9) continue;
      if (x >= x0 - 2 && x <= x1 + 2 && y >= y0 - 2 && y <= y1 + 2) return { ...o };
    }
    return null;
  };

  // The device (frame pixel) position of a point in the current user space.
  const dev = (ctx, x, y) => {
    const m = ctx.getTransform();
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  };
  // A point of a part, moved and scaled: its device position becomes (sx * x + dx, sy * y + dy), and that is turned back
  // into the current user space. With no transform the point is unchanged.
  const warp = (ctx, off, x, y) => {
    if (!off) return [x, y];
    const m = ctx.getTransform();
    const det = m.a * m.d - m.b * m.c;
    if (!det || !isFinite(det)) return [x, y];
    const [px, py] = dev(ctx, x, y);
    const X = off.sx * px + off.dx - m.e;
    const Y = off.sy * py + off.dy - m.f;
    return [(m.d * X - m.c * Y) / det, (-m.b * X + m.a * Y) / det];
  };
  // The factor a part's sizes (line width, font size, radii) change by: the square root of its area factor.
  const scaleOf = (off) => (off ? Math.sqrt(Math.abs(off.sx * off.sy)) : 1);
  const warpArgs = (ctx, args, pairs, off) => {
    if (!off) return args;
    const a = args.slice();
    for (const [ix, iy] of pairs) {
      const [x, y] = warp(ctx, off, Number(a[ix]), Number(a[iy]));
      a[ix] = x;
      a[iy] = y;
    }
    return a;
  };
  const pathPoints = (ctx) => (ctx.__vvPts || (ctx.__vvPts = []));
  const addPoints = (ctx, pts) => {
    const arr = pathPoints(ctx);
    for (const [x, y] of pts) arr.push(dev(ctx, x, y));
  };
  const boxOf = (pts, pad) => {
    if (!pts || pts.length === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    if (!isFinite(x0) || !isFinite(x1)) return null;
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  };
  // What a paint call is, apart from its number: its kind, its colour without transparency (a fade changes the alpha
  // only, so the part stays the same part), and its text. A part moved in the studio is recognised again by this key.
  const plain = (c) =>
    String(c)
      .replace(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*[\d.]+\s*\)$/i, 'rgb($1,$2,$3)')
      .replace(/^(#[0-9a-fA-F]{6})[0-9a-fA-F]{2}$/, '$1');
  const record = (ctx, kind, bbox, extra) => {
    const index = rec.index++;
    rec.frameW = ctx.canvas.width;
    rec.frameH = ctx.canvas.height;
    // A named scene (see vvScene) is part of the identity: parts of different scenes are never the same part.
    const key = kind + '|' + plain(extra.color ?? '') + '|' + String(extra.text ?? '') + (rec.scene ? '|scene:' + rec.scene : '');
    if (rec.list.length < 50000) rec.list.push({ index, kind, bbox, ...extra, key, scene: rec.scene }); // drawing outside a frame is not kept
    return index;
  };

  // Path construction: the points are moved by the transform of the paint call that will draw the path.
  const pairs = {
    moveTo: [[0, 1]],
    lineTo: [[0, 1]],
    bezierCurveTo: [[0, 1], [2, 3], [4, 5]],
    quadraticCurveTo: [[0, 1], [2, 3]],
    arcTo: [[0, 1], [2, 3]],
    rect: [[0, 1]],
    arc: [[0, 1]],
    ellipse: [[0, 1]],
  };
  for (const name of Object.keys(pairs)) {
    const orig = proto[name];
    if (typeof orig !== 'function') continue;
    proto[name] = function (...args) {
      const off = rec.offsets.get(rec.index);
      const a = warpArgs(this, args, pairs[name], off);
      const n = (v) => Number(v);
      if (off && name === 'rect') {
        a[2] = n(a[2]) * off.sx;
        a[3] = n(a[3]) * off.sy;
      }
      if (off && name === 'arc') a[2] = n(a[2]) * scaleOf(off);
      if (off && name === 'ellipse') {
        a[2] = n(a[2]) * off.sx;
        a[3] = n(a[3]) * off.sy;
      }
      if (name === 'rect') addPoints(this, [[n(a[0]), n(a[1])], [n(a[0]) + n(a[2]), n(a[1]) + n(a[3])]]);
      else if (name === 'arc') addPoints(this, [[n(a[0]) - n(a[2]), n(a[1]) - n(a[2])], [n(a[0]) + n(a[2]), n(a[1]) + n(a[2])]]);
      else if (name === 'ellipse') {
        const r = Math.max(n(a[2]), n(a[3]));
        addPoints(this, [[n(a[0]) - r, n(a[1]) - r], [n(a[0]) + r, n(a[1]) + r]]);
      } else addPoints(this, pairs[name].map(([ix, iy]) => [n(a[ix]), n(a[iy])]));
      return orig.apply(this, a);
    };
  }
  const origBeginPath = proto.beginPath;
  proto.beginPath = function (...args) {
    this.__vvPts = [];
    return origBeginPath.apply(this, args);
  };

  const isPathArg = (v) => Boolean(v) && typeof v === 'object';
  const colorOf = (value) => (typeof value === 'string' ? value : 'gradient');

  // Paint calls. Each one takes the next number, whether or not it is picked.
  const origFill = proto.fill;
  proto.fill = function (...args) {
    const bbox = isPathArg(args[0]) ? null : boxOf(this.__vvPts, 0);
    record(this, 'fill', bbox, { color: colorOf(this.fillStyle) });
    return origFill.apply(this, args);
  };
  const origStroke = proto.stroke;
  proto.stroke = function (...args) {
    // A scaled part strokes with a scaled line width (the box and the drawing use the same width).
    const k = scaleOf(rec.offsets.get(rec.index));
    const prev = this.lineWidth;
    if (k !== 1) this.lineWidth = prev * k;
    try {
      const pad = Number(this.lineWidth) || 1;
      const bbox = isPathArg(args[0]) ? null : boxOf(this.__vvPts, pad);
      record(this, 'stroke', bbox, { color: colorOf(this.strokeStyle) });
      return origStroke.apply(this, args);
    } finally {
      if (k !== 1) this.lineWidth = prev;
    }
  };

  const rectPaint = (name, kind, colorProp) => {
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (...args) {
      const off = rec.offsets.get(rec.index);
      const a = warpArgs(this, args, [[0, 1]], off);
      const n = (v) => Number(v);
      const w = off ? n(a[2]) * off.sx : n(a[2]);
      const h = off ? n(a[3]) * off.sy : n(a[3]);
      a[2] = w;
      a[3] = h;
      const bbox = boxOf([dev(this, n(a[0]), n(a[1])), dev(this, n(a[0]) + w, n(a[1]) + h)], 0);
      record(this, kind, bbox, { color: colorOf(this[colorProp]) });
      return orig.apply(this, a);
    };
  };
  rectPaint('fillRect', 'rect', 'fillStyle');
  rectPaint('strokeRect', 'rect', 'strokeStyle');

  const textPaint = (name) => {
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (...args) {
      const off = rec.offsets.get(rec.index);
      const sx = off ? off.sx : 1;
      const sy = off ? off.sy : 1;
      const n = (v) => Number(v);
      // The anchor (the text's x and y) is a point of the part: it moves and scales like one. The glyphs are drawn scaled
      // about the anchor by the same factors, so the text stays inside its box however the part is resized.
      const [ax, ay] = warp(this, off, n(args[1]), n(args[2]));
      const str = String(args[0]);
      const fontMatch = /(\d+(?:\.\d+)?)px/.exec(String(this.font));
      const size = fontMatch ? Number(fontMatch[1]) : 10;
      // The box is the text's real extent, as the browser measures it for the current alignment and baseline: a title
      // centred on x is boxed around its letters (not from x to the right), and a middle-baseline title around its height.
      const m = (() => {
        try {
          return this.measureText(str);
        } catch {
          return null;
        }
      })();
      const width = m && Number.isFinite(m.width) ? m.width : size * str.length * 0.6;
      const real = Boolean(m) && [m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent].every((v) => Number.isFinite(v));
      const align = String(this.textAlign);
      const leftRaw = real ? m.actualBoundingBoxLeft : align === 'center' ? width / 2 : align === 'right' || align === 'end' ? width : 0;
      const rightRaw = real ? m.actualBoundingBoxRight : width - leftRaw;
      const upRaw = real ? m.actualBoundingBoxAscent : size * 0.8;
      const downRaw = real ? m.actualBoundingBoxDescent : size * 0.2;
      const left = leftRaw * sx;
      const right = rightRaw * sx;
      const up = upRaw * sy;
      const down = downRaw * sy;
      const bbox = boxOf([dev(this, ax - left, ay - up), dev(this, ax + right, ay - up), dev(this, ax - left, ay + down), dev(this, ax + right, ay + down)], 0);
      record(this, 'text', bbox, { color: colorOf(name === 'fillText' ? this.fillStyle : this.strokeStyle), text: str.slice(0, 40) });
      if (off && (sx !== 1 || sy !== 1)) {
        // A scaled part: the glyphs are drawn at the anchor, scaled by the part's factors (a stroke's width scales with them).
        this.save();
        try {
          this.translate(ax, ay);
          this.scale(sx, sy);
          return orig.apply(this, [str, 0, 0, ...args.slice(3)]);
        } finally {
          this.restore();
        }
      }
      return orig.apply(this, [str, ax, ay, ...args.slice(3)]);
    };
  };
  textPaint('fillText');
  textPaint('strokeText');

  const origDrawImage = proto.drawImage;
  if (typeof origDrawImage === 'function') {
    proto.drawImage = function (...args) {
      // drawImage(image, x, y) | (image, x, y, w, h) | (image, sx, sy, sw, sh, dx, dy, dw, dh): the destination is moved
      // and scaled. A call without a size draws the image at its natural size, scaled for a part.
      const off = rec.offsets.get(rec.index);
      const d = args.length >= 9 ? 5 : 1;
      const a = warpArgs(this, args, [[d, d + 1]], off);
      const n = (v) => Number(v);
      let call = a;
      if (off) {
        if (args.length === 3) {
          const nw = Number(a[0] && a[0].width) || 0;
          const nh = Number(a[0] && a[0].height) || 0;
          call = [a[0], a[1], a[2], nw * off.sx, nh * off.sy];
        } else if (args.length === 5) {
          call = a.slice();
          call[3] = n(a[3]) * off.sx;
          call[4] = n(a[4]) * off.sy;
        } else {
          call = a.slice();
          call[7] = n(a[7]) * off.sx;
          call[8] = n(a[8]) * off.sy;
        }
      }
      const cd = call.length >= 9 ? 5 : 1;
      const cw = call.length === 3 ? Number(call[0] && call[0].width) || 0 : n(call[cd + 2]);
      const ch = call.length === 3 ? Number(call[0] && call[0].height) || 0 : n(call[cd + 3]);
      const bbox = boxOf([dev(this, n(call[cd]), n(call[cd + 1])), dev(this, n(call[cd]) + cw, n(call[cd + 1]) + ch)], 0);
      record(this, 'image', bbox, { color: '' });
      return origDrawImage.apply(this, call);
    };
  }
  return true;
}
