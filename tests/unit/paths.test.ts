import { describe, it, expect } from 'vitest';
import path from 'node:path';
// @ts-expect-error plain ESM module without type declarations
import { narrationFiles } from '../../electron/lib/paths.mjs';

describe('narration engine files', () => {
  it('are in tools/tts next to the source when running from the source', () => {
    const here = path.resolve('some', 'app', 'electron');
    const f = narrationFiles({ here, packaged: false, resourcesPath: path.resolve('ignored') });
    expect(f.dir).toBe(path.join(here, '..', 'tools', 'tts'));
    expect(f.script).toBe(path.join(f.dir, 'worker.py'));
    expect(f.config).toBe(path.join(f.dir, 'config.json'));
  });

  it('are in the resources folder once the program is installed', () => {
    const resources = path.resolve('install', 'resources');
    const f = narrationFiles({ here: path.resolve('install', 'resources', 'app.asar', 'electron'), packaged: true, resourcesPath: resources });
    expect(f.dir).toBe(path.join(resources, 'tts'));
    expect(f.script).toBe(path.join(resources, 'tts', 'worker.py'));
    expect(f.config).toBe(path.join(resources, 'tts', 'config.json'));
  });
});
