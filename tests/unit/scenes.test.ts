// Scene cuts: a part's stretch of the video ends where the scene changes, and a named scene separates its parts.
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM module without type declarations
import { sameScene } from '../../shared/project-format.mjs';
// @ts-expect-error plain ESM module without type declarations
import { installCanvasRecorder } from '../../electron/lib/render/canvas-recorder.mjs';

const op = (index: number, key: string) => ({ index, key, bbox: [0, 0, 10, 10] });

describe('same scene', () => {
  const stretching = [op(0, 'rect|#ffffff|'), op(1, 'stroke|#231f20|'), op(2, 'fill|#4570b6|'), op(3, 'text|#caebfb|C'), op(4, 'text|#231f20|Stretching')];

  it('two frames of one scene are the same scene, however the parts moved or were renumbered', () => {
    const later = [op(0, 'rect|#ffffff|'), op(1, 'stroke|#231f20|'), op(2, 'fill|#4570b6|'), op(3, 'text|#caebfb|C'), op(4, 'text|#231f20|Stretching'), op(5, 'text|#231f20|Two atoms')];
    expect(sameScene(stretching, later)).toBe(true);
  });

  it('a cut to the next scene is not the same scene, even when one spring of the same kind is still drawn', () => {
    // The Bending scene draws a dark spring under the same number as the Stretching spring, and a new title.
    const bending = [op(0, 'rect|#ffffff|'), op(1, 'stroke|#231f20|'), op(2, 'stroke|#231f20|'), op(3, 'fill|#231f20|'), op(4, 'text|#231f20|Bending')];
    expect(sameScene(stretching, bending)).toBe(false);
  });

  it('a frame with nothing drawn is not a scene', () => {
    expect(sameScene(stretching, [])).toBe(false);
    expect(sameScene([], stretching)).toBe(false);
  });
});

describe('named scenes in the canvas recorder', () => {
  function fresh() {
    const g: any = { CanvasRenderingContext2D: class {
      canvas = { width: 1080, height: 1920 };
      fillStyle = '#231f20';
      strokeStyle = '#231f20';
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
      measureText() {
        return { width: 10 };
      }
    } };
    installCanvasRecorder(g);
    return { g, ctx: new g.CanvasRenderingContext2D() };
  }

  it('without a scene name, the key is the same as before (kind, colour and text)', () => {
    const { g, ctx } = fresh();
    g.__vvOpsBegin([]);
    ctx.fillStyle = '#4570b6';
    ctx.fillText('Stretching', 0, 0);
    expect(g.__vvOpsList()[0].key).toBe('text|#4570b6|Stretching');
  });

  it('with a scene name, parts of that scene carry it in their key, so two scenes never share a part', () => {
    const { g, ctx } = fresh();
    g.__vvOpsBegin([]);
    g.vvScene('stretching');
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(10, 0);
    ctx.stroke();
    const [a] = g.__vvOpsList();
    g.__vvOpsBegin([]);
    g.vvScene('bending');
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(10, 0);
    ctx.stroke();
    const [b] = g.__vvOpsList();
    expect(a.key).not.toBe(b.key);
    expect(a.scene).toBe('stretching');
    expect(b.scene).toBe('bending');
  });

  it('a scene name is reset for each frame, so a frame that names nothing has no scene', () => {
    const { g, ctx } = fresh();
    g.__vvOpsBegin([]);
    g.vvScene('stretching');
    g.__vvOpsBegin([]);
    ctx.fillRect(0, 0, 5, 5);
    expect(g.__vvOpsList()[0].scene).toBe('');
  });
});
