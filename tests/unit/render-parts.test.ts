import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM module without type declarations
import { activeOpOffsets, normalizeRenderOptions } from '../../shared/project-format.mjs';

const part = (over: Record<string, unknown> = {}) => ({
  index: 7,
  kind: 'text',
  text: 'C',
  key: 'text|rgb(35,31,32)|C',
  t0: 5,
  t1: 14,
  dx: 60,
  dy: 0,
  ...over,
});

describe('moved parts of a canvas-drawn animation', () => {
  it('keeps the last move of the same part in the same stretch of the video, and drops one back where it started', () => {
    const r = normalizeRenderOptions({
      opOffsets: [part({ dx: 60 }), part({ dx: 10, dy: 5 }), part({ index: 9, key: 'fill|#fff|', dx: 0, dy: 0 })],
    });
    expect(r.opOffsets).toEqual([{ ...part({ dx: 10, dy: 5 }), sx: 1, sy: 1 }]);
  });

  it('keeps the same part moved in two stretches of the video as two moves', () => {
    const r = normalizeRenderOptions({ opOffsets: [part({ t0: 0, t1: 4 }), part({ t0: 20, t1: 30 })] });
    expect(r.opOffsets.map((o: { t0: number }) => o.t0)).toEqual([0, 20]);
  });

  it('drops moves saved before the stretch and the key existed: they cannot be attributed to one part', () => {
    const legacy = { index: 5, kind: 'stroke', text: '', dx: 236, dy: 16 };
    expect(normalizeRenderOptions({ opOffsets: [legacy] }).opOffsets).toEqual([]);
  });

  it('clamps the numbers and cuts long text, so a saved file cannot carry nonsense', () => {
    const r = normalizeRenderOptions({
      opOffsets: [part({ index: -4, kind: 'x'.repeat(50), text: 'y'.repeat(100), dx: 99999, dy: -99999, t0: 1, t1: 2 })],
    });
    expect(r.opOffsets[0]).toMatchObject({ index: 0, dx: 4000, dy: -4000 });
    expect(r.opOffsets[0].kind.length).toBe(20);
    expect(r.opOffsets[0].text.length).toBe(40);
  });

  it('applies a move only inside its stretch of the video', () => {
    const moves = normalizeRenderOptions({ opOffsets: [part({ t0: 5, t1: 14 })] }).opOffsets;
    expect(activeOpOffsets(moves, 4.9)).toEqual([]);
    expect(activeOpOffsets(moves, 5)).toHaveLength(1);
    expect(activeOpOffsets(moves, 14)).toHaveLength(1);
    expect(activeOpOffsets(moves, 14.5)).toEqual([]);
    expect(activeOpOffsets(undefined, 3)).toEqual([]);
  });

  it('has no parts moved by default', () => {
    expect(normalizeRenderOptions(undefined).opOffsets).toEqual([]);
  });
});

describe('moved elements of the animation', () => {
  it('keeps an element move with its tag and id, and drops a move saved without a tag', () => {
    const r = normalizeRenderOptions({
      elementOffsets: [
        { selector: 'body > div:nth-child(2)', tag: 'DIV', id: 'wave', x: 12, y: -4 },
        { selector: 'body > p', x: 3, y: 3 },
      ],
    });
    expect(r.elementOffsets).toEqual([{ selector: 'body > div:nth-child(2)', tag: 'div', id: 'wave', x: 12, y: -4 }]);
  });
});
