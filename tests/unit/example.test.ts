import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain ESM module without type declarations
import { wavFile, chimeSample, droneSample } from '../../electron/lib/samples.mjs';
// @ts-expect-error plain ESM module without type declarations
import { examplePaths } from '../../electron/lib/paths.mjs';
// @ts-expect-error plain ESM module without type declarations
import { createExample, EXAMPLE_TITLE, EXAMPLE_SECONDS } from '../../electron/lib/example.mjs';
// @ts-expect-error plain ESM module without type declarations
import { createProject, openProject } from '../../electron/lib/project.mjs';
// @ts-expect-error plain ESM module without type declarations
import { layerStates } from '../../shared/timeline.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const files = examplePaths({ here: path.join(ROOT, 'electron'), packaged: false, resourcesPath: '' });

describe('sample sounds', () => {
  it('writes a WAV file of the requested length, rate and format', () => {
    const wav = wavFile(2, () => 0.5, 24000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.length).toBe(44 + 2 * 24000 * 2);
    expect(wav.readInt16LE(44)).toBe(Math.round(0.5 * 32767));
  });

  it('keeps every sample inside the 16-bit range, even for values beyond ±1', () => {
    const wav = wavFile(0.01, () => 5);
    expect(wav.readInt16LE(44)).toBe(32767);
    const low = wavFile(0.01, () => -5);
    expect(low.readInt16LE(44)).toBe(-32767);
  });

  it('makes a chime that fades out within 2.5 s and a drone that stays quiet', () => {
    expect(chimeSample(0)).toBe(0);
    let early = 0;
    for (let i = 0; i < 2400; i++) early = Math.max(early, Math.abs(chimeSample(i / 24000)));
    expect(early).toBeGreaterThan(0.3);
    expect(chimeSample(3)).toBe(0);
    let peak = 0;
    for (let i = 0; i < 24000; i++) peak = Math.max(peak, Math.abs(droneSample(i / 24000)));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(0.31);
  });
});

describe('example files', () => {
  it('are found in development, next to the source', () => {
    for (const f of Object.values(files) as string[]) expect(fs.existsSync(f), f).toBe(true);
  });

  it('come from resources/examples when packaged', () => {
    const res = path.join('install', 'resources');
    const p = examplePaths({ here: '', packaged: true, resourcesPath: res });
    expect(p.html).toBe(path.join(res, 'examples', 'ftir-60s.html'));
    expect(p.icon).toBe(path.join(res, 'examples', 'icon.svg'));
  });
});

describe('the example project', () => {
  let parent: string;
  let proj: any;

  beforeAll(async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-example-test-'));
    proj = await createExample({ parentDir: parent, files });
  });

  afterAll(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('is named, sized for the FTIR animation, and exportable as it is', async () => {
    const { doc } = await proj.state();
    expect(doc.name).toBe(EXAMPLE_TITLE);
    expect(doc.settings.aspect).toBe('9:16');
    expect(doc.settings.durationSec).toBe(EXAMPLE_SECONDS);
    expect(doc.assets.map((a: any) => a.name).sort()).toEqual(
      ['Chime (sound effect).wav', 'Drone (background).wav', 'FTIR spectroscopy.html', 'Narration script.txt', 'VierApparatus logo.svg'].sort(),
    );
  });

  it('puts the animation on the HTML track for the whole length', async () => {
    const { doc } = await proj.state();
    const html = doc.assets.find((a: any) => a.kind === 'html');
    const clips = doc.timeline.tracks.find((t: any) => t.id === 'html').clips;
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ kind: 'html', assetId: html.id, start: 0, duration: EXAMPLE_SECONDS });
  });

  it('has the sound effect at the start and the drone under the whole example', async () => {
    const { doc } = await proj.state();
    const music = doc.timeline.tracks.find((t: any) => t.id === 'music').clips;
    expect(music).toHaveLength(2);
    const chime = music.find((c: any) => c.name === 'Chime (sound effect)');
    const drone = music.find((c: any) => c.name === 'Drone (background)');
    expect(chime).toMatchObject({ start: 0, duration: 2.5 });
    expect(drone).toMatchObject({ start: 0, duration: EXAMPLE_SECONDS, fadeIn: 2, fadeOut: 3 });
  });

  it('has the narration script as three segments with their times (audio is made on request)', async () => {
    const { doc } = await proj.state();
    expect(doc.narration.segments).toHaveLength(3);
    expect(doc.narration.segments.map((s: any) => s.status)).toEqual(['pending', 'pending', 'pending']);
    expect(doc.narration.segments[1].text).toMatch(/Vier Apparatus/);
  });

  it('shows the logo and the caption from the start', async () => {
    const { doc } = await proj.state();
    const layers = layerStates(doc.timeline.tracks, 1).layers as any[];
    expect(layers.map((l) => l.kind).sort()).toEqual(['image', 'text']);
    expect(layers.find((l) => l.kind === 'text').text).toBe('FTIR spectroscopy in 60 seconds');
  });

  it('gets a free folder name when the example already exists', async () => {
    const second = await createExample({ parentDir: parent, files });
    expect((await second.state()).doc.name).toBe(`${EXAMPLE_TITLE} (2)`);
    expect(await openProject(second.dir)).toBeTruthy();
  });
});

describe('editing an HTML animation as code', () => {
  let parent: string;
  let proj: any;
  let htmlId: string;
  let htmlFile: string;
  let original: string;

  beforeAll(async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-code-test-'));
    proj = await createProject({ parentDir: parent, name: 'Code test', settings: {} });
    await proj.importFiles([files.html, files.script]);
    const { doc } = await proj.state();
    htmlId = doc.assets.find((a: any) => a.kind === 'html').id;
    htmlFile = proj.assetFile(htmlId);
    original = fs.readFileSync(files.html, 'utf8');
  });

  afterAll(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('saves the new code in the project and keeps the original copy', async () => {
    const before = (await proj.state()).doc.assets.find((a: any) => a.id === htmlId).sha256;
    await proj.writeText(htmlId, original + '\n<!-- edited -->');
    expect(fs.readFileSync(htmlFile, 'utf8')).toBe(original + '\n<!-- edited -->');
    expect(fs.readFileSync(htmlFile + '.original', 'utf8')).toBe(original);
    const a = (await proj.state()).doc.assets.find((x: any) => x.id === htmlId);
    expect(a.sha256).not.toBe(before);
    expect(a.edited).toBe(true);
  });

  it('never changes the file the user imported', () => {
    expect(fs.readFileSync(files.html, 'utf8')).toBe(original);
  });

  it('puts the original back on request', async () => {
    await proj.restoreOriginal(htmlId);
    expect(fs.readFileSync(htmlFile, 'utf8')).toBe(original);
    const a = (await proj.state()).doc.assets.find((x: any) => x.id === htmlId);
    expect(a.edited).toBe(false);
    await expect(proj.restoreOriginal(htmlId)).rejects.toThrow(/not been edited/);
  });

  it('refuses empty code and code for anything but an HTML animation', async () => {
    await expect(proj.writeText(htmlId, '   ')).rejects.toThrow(/empty/);
    const scriptId = (await proj.state()).doc.assets.find((a: any) => a.kind === 'script').id;
    await expect(proj.writeText(scriptId, 'x')).rejects.toThrow(/Only HTML/);
    expect(fs.readFileSync(htmlFile, 'utf8')).toBe(original);
  });
});
