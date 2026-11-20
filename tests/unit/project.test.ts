import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain ESM module without type declarations
import { createProject, openProject } from '../../electron/lib/project.mjs';
// @ts-expect-error plain ESM module without type declarations
import { resolveInside, safeName, sha256File, writeJsonAtomic } from '../../electron/lib/fsx.mjs';
// @ts-expect-error plain ESM module without type declarations
import { validateProjectDoc, kindForFileName, normalizeSettings } from '../../shared/project-format.mjs';

let root: string;
let src: string;

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a6b5e5c40000000049454e44ae426082', 'hex');

function write(name: string, data: string | Buffer): string {
  const p = path.join(src, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-test-'));
  src = path.join(root, 'sources');
  fs.mkdirSync(src);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('project format (shared)', () => {
  it('detects asset kinds from file names and rejects unknown types', () => {
    expect(kindForFileName('logo.PNG')?.kind).toBe('image');
    expect(kindForFileName('icon.svg')?.kind).toBe('svg');
    expect(kindForFileName('anim.html')?.kind).toBe('html');
    expect(kindForFileName('script.md')?.kind).toBe('script');
    expect(kindForFileName('voice.mp3')?.kind).toBe('audio');
    expect(kindForFileName('clip.mov')?.kind).toBe('video');
    expect(kindForFileName('program.exe')).toBeNull();
    expect(kindForFileName('noextension')).toBeNull();
  });

  it('normalises settings and rejects bad values', () => {
    expect(normalizeSettings({ aspect: '16:9', fps: 60, durationSec: 12.5 })).toEqual({ aspect: '16:9', fps: 60, durationSec: 12.5 });
    expect(() => normalizeSettings({ aspect: '4:3', fps: 30, durationSec: 60 })).toThrow(/Aspect ratio/);
    expect(() => normalizeSettings({ aspect: '9:16', fps: 25, durationSec: 60 })).toThrow(/30 or 60/);
    expect(() => normalizeSettings({ aspect: '9:16', fps: 30, durationSec: 0 })).toThrow(/Duration/);
    expect(() => normalizeSettings({ aspect: '9:16', fps: 30, durationSec: 601 })).toThrow(/Duration/);
  });

  it('refuses asset paths that leave the project folder', () => {
    const doc = {
      format: 'viervideo-project', version: 1, id: 'p_1', name: 'x', settings: { aspect: '9:16', fps: 30, durationSec: 60 },
      folders: [], timeline: { tracks: [] },
      assets: [{ id: 'a_1', name: 'evil.png', kind: 'image', ext: '.png', file: '../../secret.png', sha256: 'a'.repeat(64) }],
    };
    expect(() => validateProjectDoc(doc)).toThrow(/outside the project/);
  });

  it('refuses newer format versions and foreign files', () => {
    expect(() => validateProjectDoc({ format: 'other' })).toThrow(/not a VierVideo project/);
    expect(() => validateProjectDoc({ format: 'viervideo-project', version: 99 })).toThrow(/newer version/);
  });

  it('unfiles assets whose folder id is unknown', () => {
    const doc = validateProjectDoc({
      format: 'viervideo-project', version: 1, id: 'p_1', name: 'x', settings: { aspect: '1:1', fps: 30, durationSec: 60 },
      folders: [{ id: 'f_1', name: 'Logos' }],
      assets: [{ id: 'a_1', name: 'a.png', kind: 'image', ext: '.png', file: 'assets/a.png', sha256: 'b'.repeat(64), folderId: 'f_missing' }],
      timeline: { tracks: [] },
    });
    expect(doc.assets[0].folderId).toBeNull();
  });
});

describe('file helpers', () => {
  it('makes safe single names', () => {
    expect(safeName('My <Film>: final?')).toBe('My _Film__ final_');
    expect(safeName('CON')).toBe('_CON');
    expect(safeName('  trailing dots... ')).toBe('trailing dots');
    expect(safeName('')).toBe('item');
  });

  it('keeps paths inside the root', () => {
    expect(resolveInside(root, 'assets/a.png')).toBe(path.join(root, 'assets', 'a.png'));
    expect(() => resolveInside(root, '../escape.txt')).toThrow(/outside the project/);
    expect(() => resolveInside(root, path.join(os.tmpdir(), 'elsewhere.txt'))).toThrow(/outside the project/);
  });

  it('hashes files with SHA-256', async () => {
    const f = write('a.bin', 'abc');
    expect(await sha256File(f)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('writes JSON atomically and keeps the previous version as .bak', async () => {
    const f = path.join(root, 'doc.json');
    await writeJsonAtomic(f, { v: 1 });
    await writeJsonAtomic(f, { v: 2 });
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ v: 2 });
    expect(JSON.parse(fs.readFileSync(f + '.bak', 'utf8'))).toEqual({ v: 1 });
    expect(fs.readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('projects', () => {
  it('creates a project folder with a document, an assets folder and default tracks', async () => {
    const proj = await createProject({ parentDir: root, name: 'FTIR in 60 seconds', settings: { aspect: '9:16', fps: 30 } });
    expect(proj.dir).toBe(path.join(root, 'FTIR in 60 seconds'));
    const doc = JSON.parse(fs.readFileSync(path.join(proj.dir, 'project.vvproj.json'), 'utf8'));
    expect(doc.format).toBe('viervideo-project');
    expect(doc.name).toBe('FTIR in 60 seconds');
    expect(doc.settings).toEqual({ aspect: '9:16', fps: 30, durationSec: 60 });
    expect(doc.timeline.tracks.map((t: { id: string }) => t.id)).toEqual(['html', 'visual', 'text', 'narration', 'music']);
    expect(fs.existsSync(path.join(proj.dir, 'assets'))).toBe(true);
  });

  it('refuses to create into a non-empty folder', async () => {
    const dir = path.join(root, 'Taken');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'mine');
    await expect(createProject({ parentDir: root, name: 'Taken', settings: {} })).rejects.toThrow(/not empty/);
    expect(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('reports a clear error for a folder that is not a project, and for damaged files', async () => {
    await expect(openProject(root)).rejects.toThrow(/No VierVideo project/);
    const proj = await createProject({ parentDir: root, name: 'Damaged', settings: {} });
    fs.writeFileSync(path.join(proj.dir, 'project.vvproj.json'), '{ not json');
    await expect(openProject(proj.dir)).rejects.toThrow(/damaged/);
  });

  it('imports files, copies them into assets, and never changes the originals', async () => {
    const proj = await createProject({ parentDir: root, name: 'Import test', settings: {} });
    const logo = write('logo.png', png);
    const svg = write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
    const md = write('script.md', '# Hook\nEvery molecule is vibrating.');
    const before = fs.readFileSync(logo);

    const { results } = await proj.importFiles([logo, svg, md], null);
    expect(results.map((r: { status: string }) => r.status)).toEqual(['imported', 'imported', 'imported']);

    const s = await proj.state();
    expect(s.doc.assets.map((a: { kind: string }) => a.kind)).toEqual(['image', 'svg', 'script']);
    for (const a of s.doc.assets) expect(fs.existsSync(path.join(proj.dir, a.file))).toBe(true);
    expect(fs.readFileSync(logo).equals(before)).toBe(true);
    expect(await proj.readText(s.doc.assets[2].id)).toContain('Every molecule');
  });

  it('does not copy the same content twice, even under another name', async () => {
    const proj = await createProject({ parentDir: root, name: 'Dedup', settings: {} });
    const a = write('one.png', png);
    const b = write('two.png', png);
    const first = await proj.importFiles([a], null);
    expect(first.results[0].status).toBe('imported');
    const second = await proj.importFiles([b, a], null);
    expect(second.results.map((r: { status: string }) => r.status)).toEqual(['duplicate', 'duplicate']);
    const s = await proj.state();
    expect(s.doc.assets).toHaveLength(1);
    expect(fs.readdirSync(path.join(proj.dir, 'assets'))).toHaveLength(1);
  });

  it('skips unsupported, empty and missing files with a reason', async () => {
    const proj = await createProject({ parentDir: root, name: 'Skips', settings: {} });
    const exe = write('setup.exe', 'MZ');
    const empty = write('empty.txt', '');
    const dir = path.join(src, 'folder.png');
    fs.mkdirSync(dir);
    const gone = path.join(src, 'gone.png');
    const { results } = await proj.importFiles([exe, empty, dir, gone], null);
    expect(results.every((r: { status: string }) => r.status === 'skipped')).toBe(true);
    expect(results.map((r: { reason: string }) => r.reason)).toEqual([
      'unsupported file type', 'file is empty', 'not a file', expect.stringMatching(/ENOENT/),
    ]);
  });

  it('removes an asset and its private copy, but not the original', async () => {
    const proj = await createProject({ parentDir: root, name: 'Remove', settings: {} });
    const logo = write('logo.png', png);
    await proj.importFiles([logo], null);
    const [asset] = (await proj.state()).doc.assets;
    const copy = path.join(proj.dir, asset.file);
    await proj.removeAsset(asset.id);
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(logo)).toBe(true);
    expect((await proj.state()).doc.assets).toEqual([]);
  });

  it('manages folders: names are unique, deleting a folder unfiles its assets', async () => {
    const proj = await createProject({ parentDir: root, name: 'Folders', settings: {} });
    await proj.createFolder('Logos');
    await expect(proj.createFolder('logos')).rejects.toThrow(/already exists/);
    const folderId = (await proj.state()).doc.folders[0].id;
    const img = write('a.png', png);
    await proj.importFiles([img], folderId);
    expect((await proj.state()).doc.assets[0].folderId).toBe(folderId);
    await proj.renameFolder(folderId, 'Brand');
    expect((await proj.state()).doc.folders[0].name).toBe('Brand');
    await proj.deleteFolder(folderId);
    const s = await proj.state();
    expect(s.doc.folders).toEqual([]);
    expect(s.doc.assets[0].folderId).toBeNull();
  });

  it('moves and renames assets; unknown targets are refused', async () => {
    const proj = await createProject({ parentDir: root, name: 'Move', settings: {} });
    await proj.createFolder('Set A');
    const folderId = (await proj.state()).doc.folders[0].id;
    await proj.importFiles([write('a.png', png)], null);
    const id = (await proj.state()).doc.assets[0].id;
    await proj.moveAsset(id, folderId);
    await proj.renameAsset(id, 'Hero image');
    const a = (await proj.state()).doc.assets[0];
    expect(a.folderId).toBe(folderId);
    expect(a.name).toBe('Hero image');
    expect(a.originalName).toBe('a.png');
    await expect(proj.moveAsset(id, 'f_nope')).rejects.toThrow(/no longer exists/);
    await expect(proj.renameAsset('a_nope', 'x')).rejects.toThrow(/no longer in the project/);
  });

  it('updates settings and keeps the timeline duration in step', async () => {
    const proj = await createProject({ parentDir: root, name: 'Settings', settings: {} });
    await proj.updateSettings({ aspect: '16:9', fps: 60, durationSec: 90 });
    const s = await proj.state();
    expect(s.doc.settings).toEqual({ aspect: '16:9', fps: 60, durationSec: 90 });
    expect(s.doc.timeline.durationSec).toBe(90);
    await expect(proj.updateSettings({ fps: 24 })).rejects.toThrow(/30 or 60/);
    expect((await proj.state()).doc.settings.fps).toBe(60);
  });

  it('persists everything across a reopen', async () => {
    const proj = await createProject({ parentDir: root, name: 'Reopen', settings: { aspect: '1:1' } });
    await proj.createFolder('Scripts');
    await proj.importFiles([write('s.txt', 'hello')], null);
    await proj.rename('Reopened name');
    const again = await openProject(proj.dir);
    const s = await again.state();
    expect(s.doc.name).toBe('Reopened name');
    expect(s.doc.settings.aspect).toBe('1:1');
    expect(s.doc.folders.map((f: { name: string }) => f.name)).toEqual(['Scripts']);
    expect(s.doc.assets.map((a: { name: string }) => a.name)).toEqual(['s.txt']);
    expect(s.missing).toEqual([]);
  });

  it('reports assets whose file was deleted from the project folder', async () => {
    const proj = await createProject({ parentDir: root, name: 'Missing', settings: {} });
    await proj.importFiles([write('a.png', png)], null);
    const s = await proj.state();
    fs.rmSync(path.join(proj.dir, s.doc.assets[0].file));
    expect((await proj.state()).missing).toEqual([s.doc.assets[0].id]);
  });

  it('only returns text for script assets and caps the size', async () => {
    const proj = await createProject({ parentDir: root, name: 'Text', settings: {} });
    await proj.importFiles([write('a.png', png), write('big.txt', 'x'.repeat(6 * 1024 * 1024))], null);
    const [img, big] = (await proj.state()).doc.assets;
    await expect(proj.readText(img.id)).rejects.toThrow(/not a text file/);
    await expect(proj.readText(big.id)).rejects.toThrow(/too large/);
  });

  it('never resolves an id that is not in the document', async () => {
    const proj = await createProject({ parentDir: root, name: 'Ids', settings: {} });
    expect(proj.assetFile('a_unknown')).toBeNull();
  });

  it('applies concurrent changes one after another without losing any', async () => {
    const proj = await createProject({ parentDir: root, name: 'Concurrent', settings: {} });
    await Promise.all(['A', 'B', 'C', 'D'].map((n) => proj.createFolder(n)));
    const names = (await proj.state()).doc.folders.map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(['A', 'B', 'C', 'D']);
    const reopened = await openProject(proj.dir);
    expect((await reopened.state()).doc.folders).toHaveLength(4);
  });
});
