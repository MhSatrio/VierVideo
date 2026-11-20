// Moving and resizing canvas parts, their groups, and selecting a group across layers and parts.
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM module without type declarations
import { composePartOffsets, composeTransforms, normalizeRenderOptions } from '../../shared/project-format.mjs';
// @ts-expect-error plain ESM module without type declarations
import { TRACK_IDS, addClip, expandGroups, makeClip, tagClips } from '../../shared/timeline.mjs';

const part = { index: 3, key: 'stroke|#4570b6|', kind: 'stroke', text: '' };
const win = { t0: 0, t1: 10 };

describe('composing the transforms of a canvas part', () => {
  it('moves a part by an offset, and drops a move that changes nothing', () => {
    const r = composePartOffsets([], part, win, { sx: 1, sy: 1, dx: 60, dy: -20 });
    expect(r).toEqual([{ index: 3, kind: 'stroke', text: '', key: part.key, t0: 0, t1: 10, sx: 1, sy: 1, dx: 60, dy: -20 }]);
    expect(composePartOffsets(r, part, win, { sx: 1, sy: 1, dx: -60, dy: 20 })).toEqual([]);
  });

  it('two moves in the same stretch add up', () => {
    let list = composePartOffsets([], part, win, { sx: 1, sy: 1, dx: 60, dy: 0 });
    list = composePartOffsets(list, part, win, { sx: 1, sy: 1, dx: 10, dy: 5 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ dx: 70, dy: 5 });
  });

  it('a resize maps the part as a box is mapped: x goes to kx x + (to.x - kx from.x)', () => {
    // The box x 100..300 becomes x 100..500 (kx = 2): a point at x = 200 goes to 100 + 2 * (200 - 100) = 300.
    const r = composePartOffsets([], part, win, { sx: 2, sy: 1, dx: 100 - 2 * 100, dy: 0 });
    expect(r[0].sx * 200 + r[0].dx).toBe(300);
    expect(r[0].sx * 100 + r[0].dx).toBe(100); // the box's left edge stays where it is
  });

  it('a move after a resize keeps the scale and moves the result', () => {
    let list = composePartOffsets([], part, win, { sx: 2, sy: 2, dx: -100, dy: 0 }); // x -> 2x - 100
    list = composePartOffsets(list, part, win, { sx: 1, sy: 1, dx: 30, dy: 0 }); // then + 30
    expect(list[0]).toMatchObject({ sx: 2, sy: 2, dx: -70 });
    expect(2 * 200 + list[0].dx).toBe(330);
  });

  it('a part moved in one stretch is not moved in another', () => {
    const list = composePartOffsets([], part, { t0: 0, t1: 4 }, { sx: 1, sy: 1, dx: 50, dy: 0 });
    const both = composePartOffsets(list, part, { t0: 20, t1: 30 }, { sx: 1, sy: 1, dx: 7, dy: 0 });
    expect(both.map((o: { t0: number; dx: number }) => [o.t0, o.dx])).toEqual([
      [0, 50],
      [20, 7],
    ]);
  });

  it('composeTransforms applies the first transform, then the second', () => {
    const r = composeTransforms({ sx: 2, sy: 2, dx: 1, dy: 0 }, { sx: 1, sy: 1, dx: 10, dy: 0 });
    // x -> 2x + 1 -> 2x + 1 + 10
    expect(r).toEqual({ sx: 2, sy: 2, dx: 11, dy: 0 });
  });
});

describe('groups of canvas parts in the project', () => {
  it('keeps a group member with its number, key and stretch; drops one without a key', () => {
    const r = normalizeRenderOptions({
      partGroups: [
        { group: 'g1', index: 3, key: part.key, kind: 'stroke', text: '', t0: 0, t1: 10 },
        { group: 'g1', index: 4, t0: 0, t1: 10 },
      ],
    });
    expect(r.partGroups).toEqual([{ group: 'g1', index: 3, kind: 'stroke', text: '', key: part.key, t0: 0, t1: 10 }]);
  });

  it('keeps a member that has not moved (a group is about what is selected, not about moves)', () => {
    const r = normalizeRenderOptions({ partGroups: [{ group: 'g1', index: 3, key: part.key, kind: 'stroke', text: '', t0: 0, t1: 10 }] });
    expect(r.opOffsets).toEqual([]);
    expect(r.partGroups).toHaveLength(1);
  });

  it('a transform saved without a scale is an unscaled one', () => {
    const r = normalizeRenderOptions({ opOffsets: [{ index: 3, key: part.key, kind: 'stroke', text: '', t0: 0, t1: 10, dx: 5, dy: 0 }] });
    expect(r.opOffsets[0]).toMatchObject({ sx: 1, sy: 1, dx: 5 });
  });
});

describe('selecting a group across layers and canvas parts', () => {
  const empty = () => TRACK_IDS.map((id) => ({ id, name: id, clips: [] as any[] }));
  const partGroups = [{ group: 'g1', index: 3, kind: 'stroke', text: '', key: part.key, t0: 0, t1: 10 }];

  it('a layer in a group brings its parts, and a part in a group brings its layers', () => {
    let tracks = addClip(empty(), makeClip('shape', 'visual', 0, 5, { id: 'box' }), 60);
    tracks = tagClips(tracks, ['box'], 'g1');
    const fromLayer = expandGroups(tracks, partGroups, { layers: ['box'], parts: [] });
    expect(fromLayer.layers).toEqual(['box']);
    expect(fromLayer.parts).toEqual([{ index: 3, key: part.key }]);
    const fromPart = expandGroups(tracks, partGroups, { layers: [], parts: [{ index: 3, key: part.key }] });
    expect(fromPart.layers).toEqual(['box']);
  });

  it('a part outside every group is selected alone', () => {
    const tracks = empty();
    const alone = expandGroups(tracks, partGroups, { layers: [], parts: [{ index: 9, key: 'fill|#fff|' }] });
    expect(alone).toEqual({ layers: [], parts: [{ index: 9, key: 'fill|#fff|' }] });
  });

  it('taking a layer out of its group leaves the group\'s other members alone', () => {
    let tracks = addClip(empty(), makeClip('shape', 'visual', 0, 5, { id: 'a' }), 60);
    tracks = addClip(tracks, makeClip('text', 'text', 0, 5, { id: 'b' }), 60);
    tracks = tagClips(tracks, ['a', 'b'], 'g1');
    tracks = tagClips(tracks, ['a'], null);
    const left = expandGroups(tracks, [], { layers: ['b'], parts: [] });
    expect(left.layers).toEqual(['b']);
    expect(tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === 'a').group).toBeNull();
  });
});
