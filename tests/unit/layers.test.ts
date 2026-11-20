// Layers as the studio edits them: HTML snippets, groups, scaling a selection, and picking with shift.
import { describe, expect, it } from 'vitest';
import {
  TRACK_IDS,
  addClip,
  groupClips,
  groupMembers,
  layerStates,
  makeClip,
  pickIds,
  reorderLayer,
  sanitizeSnippet,
  scaleLayers,
  scaledRect,
  validateTimeline,
} from '../../shared/timeline.mjs';

const TOTAL = 60;
const empty = () => TRACK_IDS.map((id) => ({ id, name: id, clips: [] as any[] }));
const put = (tracks: any[], clip: any) => addClip(tracks, clip, TOTAL);
const on = (tracks: any[], id: string) => tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === id);

describe('HTML snippets as layers', () => {
  it('removes scripts, frames and event attributes, and keeps the markup and styles', () => {
    const html =
      '<style>.x{color:red}</style><div id="a" onclick="steal()"><script>alert(1)</script><a href="javascript:alert(2)">go</a></div><iframe src="x"></iframe>';
    const clean = sanitizeSnippet(html);
    expect(clean).toContain('<style>.x{color:red}</style>');
    expect(clean).toContain('id="a"');
    expect(clean).toContain('go</a>');
    expect(clean).not.toMatch(/script|onclick|iframe|javascript:/i);
  });

  it('keeps an unclosed or plain snippet as it is, and drops comments', () => {
    expect(sanitizeSnippet('<p>one <b>two</b></p>')).toBe('<p>one <b>two</b></p>');
    expect(sanitizeSnippet('<!-- note --><span>x</span>')).toBe('<span>x</span>');
    expect(sanitizeSnippet(undefined)).toBe('');
  });

  it('is stored on the visual track with a box of its own, and the stored HTML is clean', () => {
    const clip = makeClip('snippet', 'visual', 1, 3, { html: '<p onmouseover="x()">hi</p>', name: 'Note' });
    expect(clip.html).toBe('<p>hi</p>');
    expect(clip).toMatchObject({ kind: 'snippet', x: 200, y: 300, w: 680, h: 680, group: null });
    expect(validateTimeline(put(empty(), clip))).toEqual([]);
  });

  it('is reported with its HTML and group in the layers at the playhead', () => {
    let t = put(empty(), makeClip('snippet', 'visual', 0, 5, { html: '<b>x</b>', id: 's1' }));
    t = put(t, makeClip('text', 'text', 0, 5, { text: 'Hi', id: 'tx' }));
    t = groupClips(t, ['s1', 'tx'], 'g1');
    const layers = layerStates(t, 2).layers as any[];
    expect(layers.find((l) => l.id === 's1')).toMatchObject({ kind: 'snippet', html: '<b>x</b>', group: 'g1', visible: true });
    expect(layers.find((l) => l.id === 'tx')).toMatchObject({ group: 'g1' });
    expect((layerStates(t, 9).layers as any[]).find((l) => l.id === 's1').visible).toBe(false);
  });

  it('is ordered with the other layers', () => {
    let t = put(empty(), makeClip('shape', 'visual', 0, 5, { id: 'bottom' }));
    t = put(t, makeClip('snippet', 'visual', 0, 5, { id: 's', html: '<i>x</i>' }));
    t = reorderLayer(t, 'bottom', 'forward');
    expect(t.find((tr: any) => tr.id === 'visual').clips.map((c: any) => c.id)).toEqual(['s', 'bottom']);
  });
});

describe('scaling a selection', () => {
  it('keeps a rectangle in its place inside the box when the box is doubled', () => {
    const from = { x: 100, y: 100, w: 100, h: 100 };
    const to = { x: 100, y: 100, w: 200, h: 200 };
    expect(scaledRect({ x: 100, y: 100, w: 50, h: 50 }, from, to)).toEqual({ x: 100, y: 100, w: 100, h: 100 });
    expect(scaledRect({ x: 150, y: 150, w: 10, h: 10 }, from, to)).toEqual({ x: 200, y: 200, w: 20, h: 20 });
  });

  it('resizes the selected layers together, leaves the others, and grows text with its height', () => {
    let t = put(empty(), makeClip('shape', 'visual', 0, 5, { id: 'box', x: 100, y: 100, w: 100, h: 100 }));
    t = put(t, makeClip('text', 'text', 0, 5, { id: 'txt', x: 100, y: 300, w: 200, h: 100, fontSize: 40 }));
    t = put(t, makeClip('shape', 'visual', 0, 5, { id: 'other', x: 600, y: 600, w: 50, h: 50 }));
    const r = scaleLayers(t, ['box', 'txt'], { x: 100, y: 100, w: 200, h: 300 }, { x: 100, y: 100, w: 400, h: 600 });
    expect(on(r, 'box')).toMatchObject({ x: 100, y: 100, w: 200, h: 200 });
    expect(on(r, 'txt')).toMatchObject({ x: 100, y: 500, w: 400, h: 200, fontSize: 80 });
    expect(on(r, 'other')).toMatchObject({ x: 600, y: 600, w: 50, h: 50 });
    expect(on(t, 'box')).toMatchObject({ w: 100, h: 100 }); // the input is not changed
  });

  it('keeps a size of at least one pixel when the box is squeezed', () => {
    const r = scaledRect({ x: 0, y: 0, w: 4, h: 4 }, { x: 0, y: 0, w: 400, h: 400 }, { x: 0, y: 0, w: 1, h: 1 });
    expect(r.w).toBe(1);
    expect(r.h).toBe(1);
  });
});

describe('groups and picking', () => {
  it('a click picks the whole group; shift-click adds the group, or removes it when it is in', () => {
    let t = put(empty(), makeClip('shape', 'visual', 0, 5, { id: 'a' }));
    t = put(t, makeClip('text', 'text', 0, 5, { id: 'b' }));
    t = put(t, makeClip('shape', 'visual', 0, 5, { id: 'c' }));
    t = groupClips(t, ['a', 'b'], 'g');
    expect(groupMembers(t, 'a').sort()).toEqual(['a', 'b']);
    expect(groupMembers(t, 'c')).toEqual(['c']);
    expect(groupMembers(t, 'nope')).toEqual([]);
    expect(pickIds(t, [], 'a', false).sort()).toEqual(['a', 'b']);
    expect(pickIds(t, ['c'], 'a', true).sort()).toEqual(['a', 'b', 'c']);
    expect(pickIds(t, ['a', 'b', 'c'], 'a', true)).toEqual(['c']);
  });
});
