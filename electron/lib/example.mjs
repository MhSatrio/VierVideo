// The example project: the FTIR animation with its narration script, the logo, a chime and a drone, placed on the
// timeline so that it plays and exports as it is. The first thing a new user sees, so it is kept simple.
// Everything goes through the same project functions that the user's own imports use.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, ProjectError } from './project.mjs';
import { chimeSample, droneSample, wavFile } from './samples.mjs';
import { makeClip } from '../../shared/timeline.mjs';
import { buildSegments, parseScript } from '../../shared/narration.mjs';

export const EXAMPLE_TITLE = 'Example - FTIR spectroscopy';
export const EXAMPLE_SECONDS = 60;

/**
 * Creates the example project in <parentDir>/<name>. The name gets a number if that folder is taken.
 * @param {{parentDir: string, files: {html: string, script: string, icon: string}}} o  files from examplePaths()
 * @returns {Promise<import('./project.mjs').Project>} the new project, open
 */
export async function createExample({ parentDir, files }) {
  for (const [what, file] of Object.entries(files)) {
    if (!(await fs.stat(file).then((s) => s.isFile(), () => false))) {
      throw new ProjectError(`The example file for ${what} is missing from this program (${path.basename(file)}).`);
    }
  }
  const proj = await createUniqueProject(parentDir);

  // The sounds are made here, imported like any file, and then the temporary copies are removed.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vv-example-'));
  try {
    const chime = path.join(tmp, 'chime.wav');
    const drone = path.join(tmp, 'drone.wav');
    await fs.writeFile(chime, wavFile(2.5, chimeSample));
    await fs.writeFile(drone, wavFile(EXAMPLE_SECONDS, droneSample));
    const { results } = await proj.importFiles([files.html, files.script, files.icon, chime, drone]);
    const failed = results.filter((r) => r.status !== 'imported');
    if (failed.length) throw new ProjectError(`The example could not be built: ${failed.map((r) => `${r.name} (${r.reason})`).join('; ')}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  const doc = (await proj.state()).doc;
  const byName = (name) => {
    const a = doc.assets.find((x) => x.name === name);
    if (!a) throw new ProjectError(`The example is missing ${name}.`);
    return a;
  };
  const html = byName(path.basename(files.html));
  const script = byName(path.basename(files.script));
  const icon = byName(path.basename(files.icon));
  const chime = byName('chime.wav');
  const drone = byName('drone.wav');
  await proj.renameAsset(html.id, 'FTIR spectroscopy.html');
  await proj.renameAsset(script.id, 'Narration script.txt');
  await proj.renameAsset(icon.id, 'VierApparatus logo.svg');
  await proj.renameAsset(chime.id, 'Chime (sound effect).wav');
  await proj.renameAsset(drone.id, 'Drone (background).wav');

  const parsed = parseScript(await proj.readText(script.id), script.ext);
  await proj.setNarration({ sourceAssetId: script.id, voice: 'af_heart', speed: 1, segments: buildSegments(parsed) });

  await proj.setTimeline([
    { id: 'html', clips: [makeClip('html', 'html', 0, EXAMPLE_SECONDS, { assetId: html.id, name: 'FTIR spectroscopy' })] },
    { id: 'visual', clips: [makeClip('image', 'visual', 0, EXAMPLE_SECONDS, { assetId: icon.id, name: 'VierApparatus logo', x: 60, y: 60, w: 150, h: 150 })] },
    {
      id: 'text',
      clips: [makeClip('text', 'text', 0, EXAMPLE_SECONDS, { text: 'FTIR spectroscopy in 60 seconds', x: 60, y: 1700, w: 960, h: 110, fontSize: 48 })],
    },
    {
      id: 'music',
      clips: [
        makeClip('audio', 'music', 0, 2.5, { assetId: chime.id, name: 'Chime (sound effect)', volume: 0.9 }),
        makeClip('audio', 'music', 0, EXAMPLE_SECONDS, { assetId: drone.id, name: 'Drone (background)', volume: 0.12, fadeIn: 2, fadeOut: 3 }),
      ],
    },
  ]);
  return proj;
}

async function createUniqueProject(parentDir) {
  const settings = { aspect: '9:16', fps: 30, durationSec: EXAMPLE_SECONDS };
  for (let i = 1; i <= 50; i++) {
    const name = i === 1 ? EXAMPLE_TITLE : `${EXAMPLE_TITLE} (${i})`;
    try {
      return await createProject({ parentDir, name, settings });
    } catch (err) {
      if (!(err instanceof ProjectError) || !/already exists/.test(err.message)) throw err;
    }
  }
  throw new ProjectError('Could not find a free folder name for the example project.');
}
