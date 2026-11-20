import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
// @ts-expect-error plain ESM module without type declarations
import { installClock, clockSource } from '../../electron/lib/render/clock.mjs';
// @ts-expect-error plain ESM module without type declarations
import { encoderArgs, findFfmpeg, probeFfmpeg } from '../../electron/lib/render/ffmpeg.mjs';
// @ts-expect-error plain ESM module without type declarations
import { renderVideo, RenderCancelled } from '../../electron/lib/render/job.mjs';
// @ts-expect-error plain ESM module without type declarations
import { createProject, openProject } from '../../electron/lib/project.mjs';
// @ts-expect-error plain ESM module without type declarations
import { normalizeRenderOptions, validateProjectDoc, DEFAULT_HIDE_SELECTORS } from '../../shared/project-format.mjs';

// ---------- helpers

function fakeGlobal(): any {
  return {
    Math: Object.create(Math),
    performance: { now: () => 0 },
    Date,
    document: undefined,
  };
}

function crc32(buf: Buffer): number {
  let c: number;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A valid PNG of the given size, filled with one colour (shifted per frame so frames differ). */
function makePng(w: number, h: number, shade: number): Buffer {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = shade;
    row[2 + x * 3] = 255 - shade;
    row[3 + x * 3] = 128;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-render-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- virtual clock

describe('virtual clock', () => {
  it('runs animation frames only when advanced, with the requested time', () => {
    const g = fakeGlobal();
    installClock(g, { epoch: 0, seed: 1 });
    const seen: number[] = [];
    const loop = (t: number) => {
      seen.push(t);
      g.requestAnimationFrame(loop);
    };
    g.requestAnimationFrame(loop);
    expect(seen).toEqual([]);
    g.__vvClock.advance(0);
    g.__vvClock.advance(16.5);
    g.__vvClock.advance(1000);
    expect(seen).toEqual([0, 16.5, 1000]);
  });

  it('runs timers in time order, ties in the order they were set, and skips cleared ones', () => {
    const g = fakeGlobal();
    installClock(g, { epoch: 0, seed: 1 });
    const log: string[] = [];
    g.setTimeout(() => log.push('b@200'), 200);
    g.setTimeout(() => log.push('a@100'), 100);
    g.setTimeout(() => log.push('c@100'), 100);
    const cancelled = g.setTimeout(() => log.push('never'), 50);
    g.clearTimeout(cancelled);
    g.__vvClock.advance(150);
    expect(log).toEqual(['a@100', 'c@100']);
    g.__vvClock.advance(300);
    expect(log).toEqual(['a@100', 'c@100', 'b@200']);
  });

  it('repeats intervals at their period', () => {
    const g = fakeGlobal();
    installClock(g, { epoch: 0, seed: 1 });
    let ticks = 0;
    g.setInterval(() => ticks++, 250);
    g.__vvClock.advance(999);
    expect(ticks).toBe(3); // 250, 500, 750
    g.__vvClock.advance(1000);
    expect(ticks).toBe(4);
  });

  it('makes performance.now, Date.now and new Date() follow virtual time', () => {
    const g = fakeGlobal();
    installClock(g, { epoch: Date.UTC(2026, 0, 1), seed: 1 });
    expect(g.performance.now()).toBe(0);
    g.__vvClock.advance(2500);
    expect(g.performance.now()).toBe(2500);
    expect(g.Date.now()).toBe(Date.UTC(2026, 0, 1) + 2500);
    expect(new g.Date().getTime()).toBe(Date.UTC(2026, 0, 1) + 2500);
    expect(new g.Date(0).getTime()).toBe(0); // explicit arguments still work
  });

  it('gives the same random sequence for the same seed, and a different one for another seed', () => {
    const a = fakeGlobal();
    const b = fakeGlobal();
    const c = fakeGlobal();
    installClock(a, { epoch: 0, seed: 42 });
    installClock(b, { epoch: 0, seed: 42 });
    installClock(c, { epoch: 0, seed: 43 });
    const seqA = Array.from({ length: 5 }, () => a.Math.random());
    const seqB = Array.from({ length: 5 }, () => b.Math.random());
    const seqC = Array.from({ length: 5 }, () => c.Math.random());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('holds CSS and Web animations at the requested time', () => {
    const g = fakeGlobal();
    const anims = [
      { paused: false, currentTime: 0, pause() { this.paused = true; } },
      { paused: false, currentTime: 0, pause() { this.paused = true; } },
    ];
    g.document = { getAnimations: () => anims, querySelectorAll: () => [1, 2, 3] };
    installClock(g, { epoch: 0, seed: 1 });
    const r = g.__vvClock.advance(1234);
    for (const a of anims) {
      expect(a.paused).toBe(true);
      expect(a.currentTime).toBe(1234);
    }
    expect(r.media).toBe(3); // reported so the host can warn about media it cannot drive
  });

  it('injects as valid, self-contained source', () => {
    const src = clockSource({ epoch: 5, seed: 9 });
    expect(src).not.toMatch(/__name/); // no bundler helpers in the page
    const w = fakeGlobal();
    new Function('window', src)(w);
    expect(typeof w.__vvClock.advance).toBe('function');
    expect(w.__vvClock.registered()).toBe(0);
  });
});

// ---------- FFmpeg

describe('ffmpeg helpers', () => {
  it('builds an H.264 encoder command for PNG frames on stdin', () => {
    const args = encoderArgs({ fps: 30, outFile: 'out.mp4' });
    expect(args).toEqual(expect.arrayContaining(['-f', 'image2pipe', '-framerate', '30', '-c:v', 'png', '-i', '-']));
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-an']));
    expect(args[args.length - 1]).toBe('out.mp4');
  });

  it('reports no FFmpeg when nothing works, and skips candidates that do not exist', async () => {
    expect(await probeFfmpeg('definitely-not-a-real-binary-vv')).toBeNull();
    expect(await findFfmpeg([{ source: 'none', path: null }, { source: 'missing', path: path.join(root, 'nope', 'ffmpeg.exe') }])).toBeNull();
  });

  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!hasFfmpeg)('finds ffmpeg on PATH', async () => {
    const found = await findFfmpeg([{ source: 'PATH', path: 'ffmpeg' }]);
    expect(found?.source).toBe('PATH');
    expect(found?.version).toMatch(/^ffmpeg version/);
  });

  describe.skipIf(!hasFfmpeg)('render job with a fake session', () => {
    const fakeSession = (frames: number[], opts: { failAt?: number; onFrame?: (i: number) => void } = {}) => {
      let closed = false;
      let calls = 0;
      return {
        open: async () => ({
          frame: async (ms: number) => {
            const i = calls++;
            opts.onFrame?.(i);
            if (opts.failAt === i) throw new Error('boom in the page');
            frames.push(ms);
            return makePng(32, 32, (i * 40) % 256);
          },
          close: async () => {
            closed = true;
          },
          warnings: ['test warning'],
        }),
        get closed() {
          return closed;
        },
      };
    };

    it('writes an MP4 with one frame per tick and reports progress', async () => {
      const times: number[] = [];
      const s = fakeSession(times);
      const progress: number[] = [];
      const out = path.join(root, 'clip.mp4');
      const r = await renderVideo({
        openSession: s.open,
        outFile: out,
        ffmpegPath: 'ffmpeg',
        fps: 10,
        durationSec: 1,
        mode: 'deterministic',
        onProgress: (p: { percent: number }) => progress.push(p.percent),
      });
      expect(r.frames).toBe(10);
      expect(fs.existsSync(out)).toBe(true);
      expect(fs.existsSync(out + '.part')).toBe(false);
      expect(r.bytes).toBeGreaterThan(0);
      expect(r.warnings).toEqual(['test warning']);
      expect(times).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
      expect(progress.at(-1)).toBe(100);
      expect(progress).toHaveLength(10);
      expect(s.closed).toBe(true);
    }, 60000);

    it('stops at a cancel, removes the partial file, and closes the session', async () => {
      const controller = new AbortController();
      const s = fakeSession([], { onFrame: (i) => i === 3 && controller.abort() });
      const out = path.join(root, 'cancelled.mp4');
      await expect(
        renderVideo({ openSession: s.open, outFile: out, ffmpegPath: 'ffmpeg', fps: 10, durationSec: 5, mode: 'deterministic', signal: controller.signal }),
      ).rejects.toBeInstanceOf(RenderCancelled);
      expect(fs.existsSync(out)).toBe(false);
      expect(fs.existsSync(out + '.part')).toBe(false);
      expect(s.closed).toBe(true);
    }, 60000);

    it('reports a page error without leaving files behind', async () => {
      const s = fakeSession([], { failAt: 2 });
      const out = path.join(root, 'failed.mp4');
      await expect(renderVideo({ openSession: s.open, outFile: out, ffmpegPath: 'ffmpeg', fps: 10, durationSec: 1, mode: 'deterministic' })).rejects.toThrow('boom in the page');
      expect(fs.existsSync(out)).toBe(false);
      expect(fs.existsSync(out + '.part')).toBe(false);
      expect(s.closed).toBe(true);
    }, 60000);
  });
});

// ---------- render options and records in the project

describe('render options and records', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a6b5e5c40000000049454e44ae426082', 'hex');

  it('defaults to frame-by-frame capture with the page controls hidden', () => {
    expect(normalizeRenderOptions(undefined)).toEqual({ mode: 'deterministic', hideSelectors: DEFAULT_HIDE_SELECTORS, elementOffsets: [], opOffsets: [], partGroups: [] });
    expect(() => normalizeRenderOptions({ mode: 'turbo' })).toThrow(/Render mode/);
    // angle brackets are removed (selectors are injected into a style element), surrounding spaces trimmed
    expect(normalizeRenderOptions({ hideSelectors: '  #x <b>y</b>  ' }).hideSelectors).toBe('#x by/b');
  });

  it('saves render options only on HTML assets, and records exports that survive a reopen', async () => {
    const proj = await createProject({ parentDir: root, name: 'Render records', settings: {} });
    const src = path.join(root, 'anim.html');
    const logo = path.join(root, 'logo.png');
    fs.writeFileSync(src, '<!doctype html><p>x</p>');
    fs.writeFileSync(logo, png);
    await proj.importFiles([src, logo], null);
    const [html, image] = (await proj.state()).doc.assets;

    await proj.setRenderOptions(html.id, { mode: 'realtime' });
    const s1 = await proj.state();
    expect(s1.doc.assets[0].render).toEqual({ mode: 'realtime', hideSelectors: DEFAULT_HIDE_SELECTORS, elementOffsets: [], opOffsets: [], partGroups: [] });
    await expect(proj.setRenderOptions(image.id, { mode: 'realtime' })).rejects.toThrow(/Only HTML/);

    const target = await proj.renderTarget('anim-30fps.mp4');
    expect(fs.existsSync(path.dirname(target))).toBe(true);
    expect(proj.fileInside('renders/anim-30fps.mp4')).toBe(target);
    expect(proj.fileInside('renders/../project.vvproj.json')).toBeNull();
    expect(proj.fileInside('assets/x.png')).toBeNull();

    await proj.addRender({ id: 'r_1', assetId: html.id, file: 'renders/anim-30fps.mp4', fps: 30, durationSec: 60, mode: 'realtime', frames: 1800, bytes: 10, createdAt: new Date().toISOString() });
    const again = await openProject(proj.dir);
    const s2 = await again.state();
    expect(s2.doc.renders).toHaveLength(1);
    expect(s2.doc.renders[0].file).toBe('renders/anim-30fps.mp4');
  });

  it('refuses render records that point outside renders/', () => {
    const doc = {
      format: 'viervideo-project', version: 1, id: 'p_1', name: 'x', settings: { aspect: '9:16', fps: 30, durationSec: 60 },
      folders: [], assets: [], timeline: { tracks: [] },
      renders: [{ id: 'r', file: '../escape.mp4' }, { id: 'ok', file: 'renders/ok.mp4' }],
    };
    const v = validateProjectDoc(doc);
    expect(v.renders.map((r: { id: string }) => r.id)).toEqual(['ok']);
  });
});
