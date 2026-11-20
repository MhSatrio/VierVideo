import { describe, it, expect } from 'vitest';
import {
  makeClip, addClip, moveClip, trimClip, splitClip, deleteClip, updateClip, validateTimeline,
  fadeFactor, layerStates, audioClips, isReadOnly, MIN_CLIP_SEC,
  // @ts-expect-error plain ESM module without type declarations
} from '../../shared/timeline.mjs';

const emptyTracks = () => [
  { id: 'html', name: 'HTML animation', clips: [] },
  { id: 'visual', name: 'Images & graphics', clips: [] },
  { id: 'text', name: 'Text & captions', clips: [] },
  { id: 'narration', name: 'Narration', clips: [] },
  { id: 'music', name: 'Music & sound effects', clips: [] },
];
const TOTAL = 60;

function withClip(tracks: any[], kind: string, track: string, start: number, duration: number, extra: object = {}) {
  return addClip(tracks, makeClip(kind, track, start, duration, extra), TOTAL);
}
const clipsOf = (tracks: any[], track: string) => tracks.find((t: any) => t.id === track).clips;

describe('clip defaults', () => {
  it('gives each kind its own properties', () => {
    const text = makeClip('text', 'text', 1, 3, { text: 'Hello' });
    expect(text).toMatchObject({ kind: 'text', track: 'text', start: 1, duration: 3, text: 'Hello', fontSize: 72, align: 'center', opacity: 1 });
    const shape = makeClip('shape', 'visual', 0, 2, { shape: 'ellipse', fill: '#ff0000' });
    expect(shape).toMatchObject({ shape: 'ellipse', fill: '#ff0000', stroke: '#4570b6' });
    expect(makeClip('audio', 'music', 0, 2)).toMatchObject({ volume: 1, fadeIn: 0, fadeOut: 0 });
  });

  it('rejects unknown kinds and clamps bad values', () => {
    expect(() => makeClip('video', 'visual', 0, 1)).toThrow(/Unknown clip kind/);
    const c = makeClip('text', 'text', -4, 0.01, { fontSize: 9999, opacity: 7, color: 'red' });
    expect(c.start).toBe(0);
    expect(c.duration).toBe(MIN_CLIP_SEC);
    expect(c.fontSize).toBe(400);
    expect(c.opacity).toBe(1);
    expect(c.color).toBe('#231f20');
  });
});

describe('adding clips', () => {
  it('puts a clip on a track that accepts its kind', () => {
    const t = withClip(emptyTracks(), 'text', 'text', 2, 3);
    expect(clipsOf(t, 'text')).toHaveLength(1);
  });

  it('refuses a kind on the wrong track', () => {
    expect(() => withClip(emptyTracks(), 'text', 'visual', 0, 1)).toThrow(/cannot go on the visual track/);
    expect(() => withClip(emptyTracks(), 'html', 'visual', 0, 1)).toThrow(/cannot go on the visual track/);
  });

  it('allows one HTML animation only', () => {
    const t = withClip(emptyTracks(), 'html', 'html', 0, 30, { assetId: 'a_1' });
    expect(() => withClip(t, 'html', 'html', 0, 10, { assetId: 'a_2' })).toThrow(/one HTML animation/);
  });

  it('moves a new clip inside the project', () => {
    const t = withClip(emptyTracks(), 'text', 'text', 58, 5);
    expect(clipsOf(t, 'text')[0].start).toBe(55);
  });
});

describe('moving clips', () => {
  it('moves in time and between tracks of the same kind', () => {
    let t = withClip(emptyTracks(), 'shape', 'visual', 1, 2);
    const id = clipsOf(t, 'visual')[0].id;
    t = moveClip(t, id, { start: 10, track: 'visual' }, TOTAL);
    expect(clipsOf(t, 'visual')[0].start).toBe(10);
    t = withClip(t, 'image', 'visual', 0, 1);
    const shapeNow = clipsOf(t, 'visual').find((c: any) => c.kind === 'shape');
    expect(() => moveClip(t, shapeNow.id, { track: 'text' }, TOTAL)).toThrow(/cannot go on the text track/);
  });

  it('may run past the end of the project, but never starts before 0', () => {
    let t = withClip(emptyTracks(), 'text', 'text', 0, 4);
    const id = clipsOf(t, 'text')[0].id;
    t = moveClip(t, id, { start: 58 }, TOTAL); // 58 + 4 = 62: past the 60 s end, and allowed
    expect(clipsOf(t, 'text')[0].start).toBe(58);
    expect(clipsOf(t, 'text')[0].duration).toBe(4);
    t = moveClip(t, id, { start: -3 }, TOTAL);
    expect(clipsOf(t, 'text')[0].start).toBe(0);
  });

  it('lets a clip that fills the whole project be moved later (it was pinned before)', () => {
    let t = withClip(emptyTracks(), 'image', 'visual', 0, TOTAL);
    const id = clipsOf(t, 'visual')[0].id;
    t = moveClip(t, id, { start: 5 }, TOTAL);
    expect(clipsOf(t, 'visual')[0]).toMatchObject({ start: 5, duration: TOTAL });
  });

  it('does not change the tracks it was given', () => {
    const before = withClip(emptyTracks(), 'text', 'text', 0, 4);
    const id = clipsOf(before, 'text')[0].id;
    moveClip(before, id, { start: 9 }, TOTAL);
    expect(clipsOf(before, 'text')[0].start).toBe(0);
  });
});

describe('trimming and splitting', () => {
  it('trims the end and the start', () => {
    let t = withClip(emptyTracks(), 'text', 'text', 2, 6);
    const id = clipsOf(t, 'text')[0].id;
    t = trimClip(t, id, { edge: 'end', time: 5 }, TOTAL);
    expect(clipsOf(t, 'text')[0]).toMatchObject({ start: 2, duration: 3 });
    t = trimClip(t, id, { edge: 'start', time: 4 }, TOTAL);
    expect(clipsOf(t, 'text')[0]).toMatchObject({ start: 4, duration: 1 });
  });

  it('never trims a clip to nothing', () => {
    let t = withClip(emptyTracks(), 'text', 'text', 2, 6);
    const id = clipsOf(t, 'text')[0].id;
    t = trimClip(t, id, { edge: 'end', time: 0 }, TOTAL);
    expect(clipsOf(t, 'text')[0].duration).toBeCloseTo(MIN_CLIP_SEC, 6);
    t = trimClip(t, id, { edge: 'start', time: 99 }, TOTAL);
    expect(clipsOf(t, 'text')[0].start).toBeLessThan(clipsOf(t, 'text')[0].start + clipsOf(t, 'text')[0].duration);
  });

  it('keeps the HTML animation in step when its start is trimmed', () => {
    let t = withClip(emptyTracks(), 'html', 'html', 0, 30, { assetId: 'a_1' });
    const id = clipsOf(t, 'html')[0].id;
    t = trimClip(t, id, { edge: 'start', time: 4 }, TOTAL);
    expect(clipsOf(t, 'html')[0]).toMatchObject({ start: 4, duration: 26, offset: 4 });
  });

  it('splits a layer into two clips with a new id for the second', () => {
    let t = withClip(emptyTracks(), 'text', 'text', 2, 6, { text: 'split me' });
    const id = clipsOf(t, 'text')[0].id;
    t = splitClip(t, id, { time: 5, newId: 'c_second' });
    const parts = clipsOf(t, 'text');
    expect(parts.map((c: any) => [c.id === id, c.start, c.duration])).toEqual([[true, 2, 3], [false, 5, 3]]);
    expect(parts[1].id).toBe('c_second');
    expect(parts[1].text).toBe('split me');
  });

  it('refuses a split outside the clip or the HTML animation', () => {
    let t = withClip(emptyTracks(), 'text', 'text', 2, 6);
    const id = clipsOf(t, 'text')[0].id;
    expect(() => splitClip(t, id, { time: 2 })).toThrow(/inside the clip/);
    expect(() => splitClip(t, id, { time: 8.05 })).toThrow(/inside the clip/);
    const h = withClip(emptyTracks(), 'html', 'html', 0, 30, { assetId: 'a' });
    expect(() => splitClip(h, clipsOf(h, 'html')[0].id, { time: 5 })).toThrow(/cannot be split/);
  });
});

describe('deleting and editing', () => {
  it('deletes a clip', () => {
    let t = withClip(emptyTracks(), 'text', 'text', 0, 2);
    t = deleteClip(t, clipsOf(t, 'text')[0].id);
    expect(clipsOf(t, 'text')).toHaveLength(0);
  });

  it('changes properties but not the kind', () => {
    let t = withClip(emptyTracks(), 'text', 'text', 0, 2);
    const id = clipsOf(t, 'text')[0].id;
    t = updateClip(t, id, { text: 'New words', fontSize: 40, fadeIn: 0.5 }, TOTAL);
    expect(clipsOf(t, 'text')[0]).toMatchObject({ text: 'New words', fontSize: 40, fadeIn: 0.5 });
    expect(() => updateClip(t, id, { kind: 'shape' }, TOTAL)).toThrow(/cannot change its kind/);
  });

  it('narration clips move in time, but their length stays the audio length (no trim, split or delete here)', () => {
    const narrationClip = makeClip('audio', 'narration', 1, 3, { segmentId: 'seg001' });
    let t = addClip(emptyTracks(), narrationClip, TOTAL);
    const id = clipsOf(t, 'narration')[0].id;
    expect(isReadOnly(clipsOf(t, 'narration')[0])).toBe(true);
    t = moveClip(t, id, { start: 5 }, TOTAL);
    expect(clipsOf(t, 'narration')[0]).toMatchObject({ start: 5, duration: 3, segmentId: 'seg001' });
    expect(() => deleteClip(t, id)).toThrow(/narration editor/);
    expect(() => trimClip(t, id, { edge: 'end', time: 9 }, TOTAL)).toThrow(/narration editor/);
  });
});

describe('validation', () => {
  it('accepts a clean timeline', () => {
    const t = withClip(withClip(emptyTracks(), 'html', 'html', 0, 30, { assetId: 'a' }), 'text', 'text', 1, 2);
    expect(validateTimeline(t)).toEqual([]);
  });

  it('reports duplicate ids, clips on the wrong track, and two HTML animations', () => {
    const t = emptyTracks();
    t[1].clips.push({ id: 'x', track: 'text', kind: 'text', start: 0, duration: 1 });
    t[2].clips.push({ id: 'x', track: 'text', kind: 'text', start: 0, duration: 1 });
    t[0].clips.push({ id: 'h1', track: 'html', kind: 'html', start: 0, duration: 5 });
    t[0].clips.push({ id: 'h2', track: 'html', kind: 'html', start: 0, duration: 5 });
    const problems = validateTimeline(t).join(' | ');
    expect(problems).toMatch(/share the id x/);
    expect(problems).toMatch(/wrong track/);
    expect(problems).toMatch(/one HTML animation/);
  });
});

describe('fades and layer state at a time', () => {
  it('ramps a fade-in and a fade-out', () => {
    const c = { start: 2, duration: 4, fadeIn: 1, fadeOut: 1 };
    expect(fadeFactor(c, 2)).toBe(0);
    expect(fadeFactor(c, 2.5)).toBeCloseTo(0.5, 6);
    expect(fadeFactor(c, 4)).toBe(1);
    expect(fadeFactor(c, 5.5)).toBeCloseTo(0.5, 6);
  });

  it('reports the base animation time and which layers are visible, in draw order', () => {
    let t = withClip(emptyTracks(), 'html', 'html', 5, 10, { assetId: 'anim', offset: 2 });
    t = withClip(t, 'shape', 'visual', 0, 20, { id: 'bg' });
    t = withClip(t, 'text', 'text', 6, 2, { id: 'title', opacity: 0.5 });
    const s = layerStates(t, 6);
    expect(s.base).toEqual({ visible: true, animSec: 3, assetId: 'anim' });
    expect(s.layers.map((l: any) => [l.id, l.visible])).toEqual([['bg', true], ['title', true]]);
    expect(s.layers[1].z).toBeGreaterThan(s.layers[0].z);
    const before = layerStates(t, 4);
    expect(before.base.visible).toBe(false);
    expect(before.layers.find((l: any) => l.id === 'title').visible).toBe(false);
  });

  it('applies fades to the opacity of a layer', () => {
    let t = withClip(emptyTracks(), 'text', 'text', 0, 4, { id: 'f', fadeIn: 2, opacity: 0.8 });
    expect(layerStates(t, 1).layers[0].opacity).toBeCloseTo(0.4, 2);
  });

  it('lists the audio clips for the mix (narration and music)', () => {
    let t = withClip(emptyTracks(), 'audio', 'music', 0, 5, { assetId: 'm1', volume: 0.5 });
    t = addClip(t, makeClip('audio', 'narration', 1, 2, { segmentId: 's1' }), TOTAL);
    expect(audioClips(t).map((c: any) => c.track).sort()).toEqual(['music', 'narration']);
  });
});

describe('ordering layers (bring forward, send backward)', () => {
  it('moves a layer above or below its neighbour in its track, and leaves the other layers alone', async () => {
    const { reorderLayer } = await import('../../shared/timeline.mjs');
    let t = withClip(emptyTracks(), 'text', 'text', 0, 2);
    t = withClip(t, 'shape', 'visual', 0, 2);
    t = withClip(t, 'image', 'visual', 0, 2);
    const [a, b] = clipsOf(t, 'visual').map((c: any) => c.id);
    const moved = reorderLayer(t, a, 'forward');
    expect(clipsOf(moved, 'visual').map((c: any) => c.id)).toEqual([b, a]);
    expect(clipsOf(moved, 'text')).toHaveLength(1);
    expect(reorderLayer(moved, a, 'backward').length).toBe(moved.length);
    expect(clipsOf(reorderLayer(moved, a, 'backward'), 'visual').map((c: any) => c.id)).toEqual([a, b]);
  });

  it('does nothing past the end of the track, and refuses the html animation and audio', async () => {
    const { reorderLayer } = await import('../../shared/timeline.mjs');
    let t = withClip(emptyTracks(), 'shape', 'visual', 0, 2);
    const only = clipsOf(t, 'visual')[0].id;
    expect(clipsOf(reorderLayer(t, only, 'forward'), 'visual').map((c: any) => c.id)).toEqual([only]);
    expect(() => reorderLayer(t, only, 'sideways' as any)).toThrow(/forward/);
    const audio = addClip(emptyTracks(), makeClip('audio', 'music', 0, 2, { assetId: 'x' }), TOTAL);
    expect(() => reorderLayer(audio, clipsOf(audio, 'music')[0].id, 'forward')).toThrow(/order/);
  });
});

describe('grouping layers', () => {
  it('groups layers, moves them as a group (shift), and ungroups them', async () => {
    const { groupClips, ungroupClips, shiftLayers } = await import('../../shared/timeline.mjs');
    let t = withClip(emptyTracks(), 'text', 'text', 0, 2);
    t = withClip(t, 'shape', 'visual', 0, 2);
    t = withClip(t, 'image', 'visual', 0, 2);
    const [a, b, c] = [clipsOf(t, 'text')[0].id, clipsOf(t, 'visual')[0].id, clipsOf(t, 'visual')[1].id];
    const grouped = groupClips(t, [a, b], 'grp1');
    expect(clipsOf(grouped, 'text')[0].group).toBe('grp1');
    expect(clipsOf(grouped, 'visual')[0].group).toBe('grp1');
    expect(clipsOf(grouped, 'visual')[1].group).toBeNull();
    const before = clipsOf(grouped, 'visual')[0].x;
    const moved = shiftLayers(grouped, [a, b], 30, -10);
    expect(clipsOf(moved, 'visual')[0].x).toBe(before + 30);
    expect(clipsOf(moved, 'visual')[1].x).toBe(clipsOf(grouped, 'visual')[1].x); // not in the group: unchanged
    const apart = ungroupClips(grouped, [a]);
    expect(clipsOf(apart, 'text')[0].group).toBeNull();
    expect(clipsOf(apart, 'visual')[0].group).toBeNull();
    expect(c).toBeTruthy();
  });

  it('refuses a group of one layer, and a group that holds the animation', async () => {
    const { groupClips } = await import('../../shared/timeline.mjs');
    let t = withClip(emptyTracks(), 'text', 'text', 0, 2);
    const one = clipsOf(t, 'text')[0].id;
    expect(() => groupClips(t, [one], 'g')).toThrow(/two or more/);
    t = withClip(t, 'html', 'html', 0, 2);
    const html = clipsOf(t, 'html')[0].id;
    expect(() => groupClips(t, [one, html], 'g')).toThrow(/images, shapes and text/);
  });
});
