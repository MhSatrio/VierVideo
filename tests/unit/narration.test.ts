import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  VOICE_IDS, parseTime, parseScript, splitPlain, stripMarkdown, buildSegments, layoutStarts, timingWarnings,
  segmentSignature, hashString, clampSpeed, SEGMENT_GAP_SEC, MAX_SEGMENT_CHARS,
  // @ts-expect-error plain ESM module without type declarations
} from '../../shared/narration.mjs';
// @ts-expect-error plain ESM module without type declarations
import { normalizeNarration, validateProjectDoc } from '../../shared/project-format.mjs';

const ROOT = process.cwd(); // vitest runs from the project root

describe('times', () => {
  it('reads m:ss, h:mm:ss, decimals and plain seconds', () => {
    expect(parseTime('0:05')).toBe(5);
    expect(parseTime('00:01:05.5')).toBe(65.5);
    expect(parseTime('1:02,5'.replace(',', '.'))).toBe(62.5);
    expect(parseTime(3)).toBe(3);
    expect(parseTime('soon')).toBeNull();
    expect(parseTime('2-3')).toBeNull();
    expect(parseTime(-1)).toBeNull();
  });
});

describe('script formats', () => {
  it('reads the timed lines of the batch-6 style', () => {
    const r = parseScript('[00:00 - 00:04] Every molecule is vibrating.\n[00:04 - 00:09] Second line.\n', '.txt');
    expect(r.format).toBe('timed');
    expect(r.segments).toEqual([
      { start: 0, end: 4, text: 'Every molecule is vibrating.' },
      { start: 4, end: 9, text: 'Second line.' },
    ]);
  });

  it('accepts timestamps without brackets and with a colon separator', () => {
    const r = parseScript('0:05 - 0:12: Welcome.\n0:12 – 0:18 | Next.\n', '.txt');
    expect(r.segments.map((s: { text: string }) => s.text)).toEqual(['Welcome.', 'Next.']);
  });

  it('joins continuation lines to the previous timed segment', () => {
    const r = parseScript('[00:00 - 00:04] First part\nsecond part.\n', '.txt');
    expect(r.segments[0].text).toBe('First part second part.');
  });

  it('warns about text before the first timestamp', () => {
    const r = parseScript('Intro text\n[00:01 - 00:03] Body.\n', '.txt');
    expect(r.warnings.join(' ')).toMatch(/before the first timestamp/);
  });

  it('reads SRT and WebVTT cues', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,500\nHello there.\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond cue\nin two lines.\n';
    const a = parseScript(srt, '.srt');
    expect(a.format).toBe('srt');
    expect(a.segments).toEqual([
      { start: 1, end: 3.5, text: 'Hello there.' },
      { start: 4, end: 6, text: 'Second cue in two lines.' },
    ]);
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA cue.\n';
    expect(parseScript(vtt, '.vtt').format).toBe('vtt');
  });

  it('reads JSON arrays, objects with a segments list, and plain string arrays', () => {
    expect(parseScript('[{"start":"0:02","end":5,"text":"One."},{"text":"Two."}]', '.json').segments).toEqual([
      { start: 2, end: 5, text: 'One.' },
      { start: null, end: null, text: 'Two.' },
    ]);
    expect(parseScript('{"segments":[{"time":3,"narration":"Hi."}]}', '.json').segments[0]).toEqual({ start: 3, end: null, text: 'Hi.' });
    expect(parseScript('["First sentence. Second.", "Third."]', '.json').segments.length).toBe(2);
    expect(parseScript('{ broken', '.json').warnings[0]).toMatch(/not valid/);
  });

  it('reads CSV with a header and without one', () => {
    const withHeader = parseScript('start,end,text\n0:01,0:03,"Quoted, with comma."\n0:04,0:06,Plain\n', '.csv');
    expect(withHeader.segments).toEqual([
      { start: 1, end: 3, text: 'Quoted, with comma.' },
      { start: 4, end: 6, text: 'Plain' },
    ]);
    const noHeader = parseScript('0:01;0:03;Semicolons work too\n', '.csv');
    expect(noHeader.segments[0].text).toBe('Semicolons work too');
  });

  it('splits plain text into sentence groups and keeps paragraphs apart', () => {
    const para = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ');
    const chunks = splitPlain(para + '\n\nA new paragraph.');
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(0, -1)) expect(c.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
    expect(chunks[chunks.length - 1]).toBe('A new paragraph.');
  });

  it('removes markdown that would be read aloud', () => {
    const md = '# Title\n\n- **Bold** point with [a link](https://x.y) and `code`.\n\n```\nhidden\n```\n';
    const out = stripMarkdown(md);
    expect(out).toContain('Bold point with a link and code.');
    expect(out).not.toContain('hidden');
    expect(parseScript(md, '.md').segments.map((s: { text: string }) => s.text)).toEqual(['Title', 'Bold point with a link and code.']);
  });

  it('reports an empty script', () => {
    expect(parseScript('   \n\n', '.txt').warnings).toEqual(['The script has no text.']);
  });
});

describe('segments and layout', () => {
  it('sorts timed segments and numbers them', () => {
    const segs = buildSegments({ segments: [{ start: 5, end: 7, text: 'b' }, { start: 1, end: 3, text: 'a' }] });
    expect(segs.map((s: { text: string; index: number }) => [s.text, s.index])).toEqual([['a', 1], ['b', 2]]);
    expect(segs[0].status).toBe('pending');
  });

  it('keeps timed starts and places untimed segments after the previous one', () => {
    const segs = buildSegments({ segments: [{ start: 0, end: 2, text: 'a' }, { start: null, end: null, text: 'b' }, { start: null, end: null, text: 'c' }] });
    const starts = layoutStarts(segs, [1.5, 2, 1]);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeCloseTo(Math.max(0, 1.5) + SEGMENT_GAP_SEC, 6);
    expect(starts[2]).toBeCloseTo(starts[1] + 2 + SEGMENT_GAP_SEC, 6);
  });

  it('flags a clip that runs past its end time or into the next segment', () => {
    const segs = [
      { id: 's1', index: 1, start: 0, end: 2, status: 'ok', durationSec: 3.4 },
      { id: 's2', index: 2, start: 3, end: 6, status: 'ok', durationSec: 1 },
      { id: 's3', index: 3, start: 9, end: 12, status: 'ok', durationSec: 1 },
    ];
    const w = timingWarnings(segs).map((x: { message: string }) => x.message);
    expect(w.some((m: string) => m.includes('slot ends'))).toBe(true);
    expect(w.some((m: string) => m.includes('runs into segment 2'))).toBe(true);
    expect(timingWarnings([{ ...segs[2], status: 'pending', durationSec: null }])).toEqual([]);
  });
});

describe('signatures and speed', () => {
  it('changes when the text, voice or speed changes, and not otherwise', () => {
    const base = segmentSignature({ text: 'Hi.', voice: 'af_heart', speed: 1 });
    expect(segmentSignature({ text: 'Hi.', voice: 'af_heart', speed: 1 })).toBe(base);
    expect(segmentSignature({ text: 'Hi!', voice: 'af_heart', speed: 1 })).not.toBe(base);
    expect(segmentSignature({ text: 'Hi.', voice: 'bf_emma', speed: 1 })).not.toBe(base);
    expect(segmentSignature({ text: 'Hi.', voice: 'af_heart', speed: 1.1 })).not.toBe(base);
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps speed in range', () => {
    expect(clampSpeed(0.1)).toBe(0.7);
    expect(clampSpeed(9)).toBe(1.3);
    expect(clampSpeed('x')).toBe(1);
    expect(clampSpeed(1.234)).toBe(1.23);
  });
});

describe('narration in the project file', () => {
  const doc = (narration: unknown) => ({
    format: 'viervideo-project', version: 1, id: 'p', name: 'x', settings: { aspect: '9:16', fps: 30, durationSec: 60 },
    folders: [], assets: [], timeline: { tracks: [] }, narration,
  });

  it('keeps a valid narration and fixes an unknown voice and an out-of-range speed', () => {
    const n = validateProjectDoc(doc({ sourceAssetId: null, voice: 'zz_nope', speed: 5, segments: [{ id: 's1', text: 'Hi.', status: 'ok', file: 'audio/narration/s1-1.wav' }] })).narration;
    expect(n.voice).toBe('af_heart');
    expect(n.speed).toBe(1.3);
    expect(n.segments[0].status).toBe('ok');
  });

  it('refuses audio paths outside audio/', () => {
    const n = normalizeNarration({ voice: 'af_heart', speed: 1, segments: [{ id: 's1', text: 'Hi.', status: 'ok', file: '../secret.wav' }] });
    expect(n.segments[0].file).toBeNull();
    expect(n.segments[0].status).toBe('pending');
  });

  it('treats a missing narration as null', () => {
    expect(validateProjectDoc(doc(undefined)).narration).toBeNull();
  });
});

describe('voice pack', () => {
  it('lists the same voices as the Python config (tools/tts/config.json)', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'tts', 'config.json'), 'utf8'));
    expect(cfg.voices.map((v: { id: string }) => v.id).sort()).toEqual([...VOICE_IDS].sort());
    expect(VOICE_IDS).toHaveLength(8);
  });

  it('has the Vier pronunciation rule from batch 6', () => {
    const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'tts', 'pronunciations.json'), 'utf8')).rules;
    expect(rules.some((r: string[]) => r[0] === '\\bVier\\b' && r[1].includes('vˈɪɹ'))).toBe(true);
  });
});
