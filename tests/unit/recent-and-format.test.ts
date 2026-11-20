import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatBytes, formatTimecode, rulerStep, assetUrl, shortHash } from '../../src/model/format';
// @ts-expect-error plain ESM module without type declarations
import { RecentProjects } from '../../electron/lib/recent.mjs';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-recent-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recent projects', () => {
  it('lists the newest first, without duplicates (case-insensitive path)', async () => {
    const r = new RecentProjects(path.join(dir, 'recent.json'));
    await r.add({ dir: 'C:/Work/One', name: 'One' });
    await r.add({ dir: 'C:/Work/Two', name: 'Two' });
    await r.add({ dir: 'c:/work/one', name: 'One again' });
    const list = await r.list();
    expect(list.map((x: { name: string }) => x.name)).toEqual(['One again', 'Two']);
  });

  it('keeps at most ten entries', async () => {
    const r = new RecentProjects(path.join(dir, 'recent.json'));
    for (let i = 0; i < 12; i++) await r.add({ dir: `C:/P/${i}`, name: `P${i}` });
    const list = await r.list();
    expect(list).toHaveLength(10);
    expect(list[0].name).toBe('P11');
  });

  it('forgets an entry without touching anything else', async () => {
    const r = new RecentProjects(path.join(dir, 'recent.json'));
    await r.add({ dir: 'C:/A', name: 'A' });
    await r.add({ dir: 'C:/B', name: 'B' });
    await r.remove('C:/A');
    expect((await r.list()).map((x: { name: string }) => x.name)).toEqual(['B']);
  });

  it('treats a damaged list as empty instead of failing', async () => {
    const file = path.join(dir, 'recent.json');
    fs.writeFileSync(file, '{broken');
    expect(await new RecentProjects(file).list()).toEqual([]);
  });
});

describe('display helpers', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(-1)).toBe('—');
  });

  it('formats timecodes for the ruler', () => {
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(65)).toBe('1:05');
    expect(formatTimecode(12.7, true)).toBe('0:12.7');
  });

  it('picks a readable ruler step for the zoom level', () => {
    expect(rulerStep(40)).toBe(2);
    expect(rulerStep(200)).toBe(0.5);
    expect(rulerStep(10)).toBe(10);
  });

  it('builds asset urls that cannot break out of the asset path', () => {
    expect(assetUrl('a_1')).toBe('vvasset://asset/a_1');
    expect(assetUrl('a/../../x')).toBe('vvasset://asset/a%2F..%2F..%2Fx');
    expect(shortHash('abcdef0123456789')).toBe('abcdef012345');
  });
});
