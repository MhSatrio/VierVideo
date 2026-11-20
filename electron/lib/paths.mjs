// Where the files that Python must read live. In development they sit in tools/tts next to the source. In the
// installed program they are copied to the resources folder, because Python cannot read files inside app.asar.
import path from 'node:path';

/**
 * @param {{here: string, packaged: boolean, resourcesPath: string}} o  here = the electron/ folder of the source
 * @returns {{dir: string, script: string, config: string}} the narration engine's folder, worker and voice settings
 */
export function narrationFiles({ here, packaged, resourcesPath }) {
  const dir = packaged ? path.join(resourcesPath, 'tts') : path.join(here, '..', 'tools', 'tts');
  return { dir, script: path.join(dir, 'worker.py'), config: path.join(dir, 'config.json') };
}

/**
 * Files of the example project: the FTIR animation, its narration script and the logo.
 * In development they come from the test fixtures and the public folder; in the installed program from resources/examples.
 * @returns {{html: string, script: string, icon: string}}
 */
export function examplePaths({ here, packaged, resourcesPath }) {
  if (packaged) {
    const dir = path.join(resourcesPath, 'examples');
    return { html: path.join(dir, 'ftir-60s.html'), script: path.join(dir, 'narration-sample.txt'), icon: path.join(dir, 'icon.svg') };
  }
  return {
    html: path.join(here, '..', 'tests', 'fixtures', 'ftir-60s.html'),
    script: path.join(here, '..', 'tests', 'fixtures', 'narration-sample.txt'),
    icon: path.join(here, '..', 'public', 'icon.svg'),
  };
}
