import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM module without type declarations
import { installCanvasRecorder } from '../../electron/lib/render/canvas-recorder.mjs';

/** A canvas context with the methods the recorder wraps. The originals draw nothing; only the recorder's record is used. */
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
  fillText() {}
  measureText(t: string) {
    return { width: t.length * 10 };
  }
}

function fresh() {
  const g: any = { CanvasRenderingContext2D: class extends FakeCtx {} };
  installCanvasRecorder(g);
  const ctx: any = new g.CanvasRenderingContext2D();
  return { g, ctx };
}

describe('canvas recorder: boxes of text', () => {
  it('boxes a centred title around its letters, and a middle-baseline title around its height', () => {
    // A 300 px wide title centred on x, 100 px above the baseline and 20 px below (the browser's measurement).
    class CentredCtx extends FakeCtx {
      textAlign = 'center';
      textBaseline = 'middle';
      measureText() {
        return { width: 300, actualBoundingBoxLeft: 150, actualBoundingBoxRight: 150, actualBoundingBoxAscent: 100, actualBoundingBoxDescent: 20 };
      }
    }
    const g: any = { CanvasRenderingContext2D: CentredCtx };
    installCanvasRecorder(g);
    const ctx: any = new g.CanvasRenderingContext2D();
    g.__vvOpsBegin([]);
    ctx.fillText('FTIR', 540, 900);
    const [title] = g.__vvOpsList();
    expect(title.bbox).toEqual([390, 800, 690, 920]); // from x - 150 to x + 150, from y - 100 to y + 20
  });

  it('falls back to the width when the browser does not give the measured bounds', () => {
    const { g, ctx } = fresh();
    g.__vvOpsBegin([]);
    ctx.fillText('abc', 100, 200); // left-aligned, width 30: the box runs from x to x + 30
    const [title] = g.__vvOpsList();
    expect(title.bbox[0]).toBeCloseTo(100, 5);
    expect(title.bbox[2]).toBeCloseTo(130, 5);
  });
});

describe('canvas recorder: paint calls, their keys and moved parts', () => {
  it('numbers the paint calls of a frame and gives each one a key (kind, colour without fade, text)', () => {
    const { g, ctx } = fresh();
    g.__vvOpsBegin([]);
    ctx.fillStyle = 'rgba(35,31,32,0.5)'; // a fade: the alpha changes, the part does not
    ctx.fillText('Stretching', 10, 100, 500);
    ctx.strokeStyle = '#4570b6';
    ctx.beginPath();
    ctx.moveTo(0, 200);
    ctx.lineTo(400, 200);
    ctx.stroke();
    const list = g.__vvOpsList();
    expect(list.map((o: any) => o.index)).toEqual([0, 1]);
    expect(list[0].key).toBe('text|rgb(35,31,32)|Stretching');
    expect(list[1].key).toBe('stroke|#4570b6|');
  });

  it('moves a part by the offset of its number, and no other part', () => {
    const { g, ctx } = fresh();
    g.__vvOpsBegin([{ index: 1, dx: 100, dy: 0 }]);
    ctx.fillText('title', 10, 100);
    ctx.beginPath();
    ctx.moveTo(0, 200);
    ctx.lineTo(400, 200);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 300);
    ctx.lineTo(400, 300);
    ctx.stroke();
    const [, moved, other] = g.__vvOpsList();
    expect(moved.bbox[0]).toBeCloseTo(99, 5); // 0 - the line width, plus the offset of 100
    expect(other.bbox[0]).toBeCloseTo(-1, 5);
  });
});
