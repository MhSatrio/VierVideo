// The canvas recorder changes a part by its transform: moved, and scaled about the origin of its group.
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM module without type declarations
import { installCanvasRecorder } from '../../electron/lib/render/canvas-recorder.mjs';

class FakeCtx {
  canvas = { width: 1080, height: 1920 };
  fillStyle = '#000000';
  strokeStyle = '#000000';
  lineWidth = 1;
  font = '40px sans-serif';
  getTransform() {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
  beginPath() {}
  moveTo() {}
  lineTo() {}
  stroke() {}
  fill() {}
  fillRect() {}
  fillText() {}
  save() {}
  restore() {}
  translate() {}
  scale() {}
  measureText(t: string) {
    return { width: t.length * 10 };
  }
}

function fresh(offsets: unknown[]) {
  const g: any = { CanvasRenderingContext2D: class extends FakeCtx {} };
  installCanvasRecorder(g);
  g.__vvOpsBegin(offsets);
  const ctx: any = new g.CanvasRenderingContext2D();
  return { g, ctx };
}

describe('canvas recorder: a part is scaled and moved', () => {
  it('scales a rectangle about the origin of its group: the box keeps the rectangle inside the scaled area', () => {
    const { g, ctx } = fresh([{ index: 0, sx: 2, sy: 2, dx: 0, dy: 0 }]);
    ctx.fillRect(10, 10, 20, 20);
    const [r] = g.__vvOpsList();
    expect(r.bbox).toEqual([20, 20, 60, 60]);
  });

  it('moves a path point by the scale and the offset: x goes to sx x + dx', () => {
    const { g, ctx } = fresh([{ index: 1, sx: 2, sy: 1, dx: 5, dy: 0 }]);
    ctx.fillText('title', 0, 0); // paint call 0: not moved
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(20, 0);
    ctx.stroke(); // paint call 1: x = 10 -> 25, x = 20 -> 45
    const [, s] = g.__vvOpsList();
    // The line width scales by the square root of the area factor (sqrt(2 x 1)), and that is the padding.
    expect(s.bbox[0]).toBeCloseTo(25 - Math.SQRT2, 5);
    expect(s.bbox[2]).toBeCloseTo(45 + Math.SQRT2, 5);
  });

  it('scales a stroke width with the part, so the stroke keeps its proportion', () => {
    const { g, ctx } = fresh([{ index: 0, sx: 4, sy: 4, dx: 0, dy: 0 }]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(100, 0);
    ctx.stroke();
    const [s] = g.__vvOpsList();
    // The path is scaled to x 0..400; the box is padded by the scaled line width (2 x 4 = 8), as strokes always are.
    expect(s.bbox[0]).toBeCloseTo(-8, 5);
    expect(s.bbox[2]).toBeCloseTo(408, 5);
    expect(ctx.lineWidth).toBe(2); // the context's own width is put back
  });

  it('boxes a text part by its factors, so a non-uniform resize keeps the text inside its box', () => {
    // A text 40 px tall, resized 2 x wide and 1 x tall about the origin: its box is twice as wide as the unscaled one.
    const { g, ctx } = fresh([{ index: 0, sx: 2, sy: 1, dx: 0, dy: 0 }]);
    ctx.fillText('abc', 100, 200);
    const [t] = g.__vvOpsList();
    const plain = (() => {
      const r = fresh([]);
      r.ctx.fillText('abc', 100, 200);
      return r.g.__vvOpsList()[0];
    })();
    expect(t.bbox[2] - t.bbox[0]).toBeCloseTo(2 * (plain.bbox[2] - plain.bbox[0]), 5);
    expect(t.bbox[3] - t.bbox[1]).toBeCloseTo(plain.bbox[3] - plain.bbox[1], 5);
    expect(ctx.font).toBe('40px sans-serif');
  });

  it('leaves a part with no transform as it is', () => {
    const { g, ctx } = fresh([]);
    ctx.fillRect(10, 10, 20, 20);
    const [r] = g.__vvOpsList();
    expect(r.bbox).toEqual([10, 10, 30, 30]);
  });
});
