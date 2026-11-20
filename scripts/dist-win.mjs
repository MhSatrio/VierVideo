/**
 * Builds the Windows installer:  npm run dist:win
 *
 *   1. builds the app (typecheck and bundle),
 *   2. stages FFmpeg next to the build: ffmpeg.exe from VV_FFMPEG_SOURCE, or else the one on PATH, plus a notice
 *      file with its version and license,
 *   3. runs electron-builder (NSIS) with the "build" section of package.json plus the staged FFmpeg. The config is
 *      written into the output folder with absolute paths, so the repository holds no machine-specific paths.
 *
 * The output goes to <your home folder>\VierVideo-release (override with VV_OUT=...), deliberately outside the
 * project: a OneDrive-synced folder locks freshly written files (EPERM) and would upload the build output.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = process.env.VV_OUT || path.join(homedir(), 'VierVideo-release');
const stage = path.join(out, 'stage', 'ffmpeg');

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

/**
 * Runs a program without a shell (so paths with spaces are safe; npm.cmd would need a shell on Windows, so the
 * tools are started with node directly). Exits the script if it fails.
 */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    fail(`${path.basename(cmd)} ${args.slice(0, 2).join(' ')} failed (exit ${r.status ?? 'none'}${r.error ? `: ${r.error.message}` : ''}).`);
  }
}

/** Finds ffmpeg.exe: the one named in VV_FFMPEG_SOURCE, else the first one on PATH. */
function findFfmpeg() {
  if (process.env.VV_FFMPEG_SOURCE) {
    if (!fs.existsSync(process.env.VV_FFMPEG_SOURCE)) fail(`VV_FFMPEG_SOURCE does not exist: ${process.env.VV_FFMPEG_SOURCE}`);
    return process.env.VV_FFMPEG_SOURCE;
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, ['ffmpeg'], { encoding: 'utf8' });
  const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!first) fail('FFmpeg was not found. Install it (for example: winget install Gyan.FFmpeg) or set VV_FFMPEG_SOURCE.');
  return first;
}

/**
 * The example project's files: the FTIR animation and its script, and the logo. The animation is the test file
 * (tests/fixtures/ftir-60s.html). It is included by default, for your own installs; set VV_NO_EXAMPLE_ANIMATION=1 to
 * leave it out, in which case the example cannot be created in the installed program.
 */
function stageExamples() {
  const dir = path.join(out, 'stage', 'examples');
  fs.rmSync(dir, { recursive: true, force: true }); // so an older copy of the animation cannot stay behind
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ['tests/fixtures/narration-sample.txt', 'narration-sample.txt'],
    ['public/icon.svg', 'icon.svg'],
  ];
  if (process.env.VV_NO_EXAMPLE_ANIMATION !== '1') files.push(['tests/fixtures/ftir-60s.html', 'ftir-60s.html']);
  for (const [from, to] of files) fs.copyFileSync(path.join(root, from), path.join(dir, to));
  console.log(`example files staged: ${files.map(([, to]) => to).join(', ')}`);
}

function stageFfmpeg() {
  const source = findFfmpeg();
  fs.mkdirSync(stage, { recursive: true });
  const target = path.join(stage, 'ffmpeg.exe');
  fs.copyFileSync(source, target);
  const info = spawnSync(target, ['-version'], { encoding: 'utf8' });
  if (info.status !== 0) fail(`The FFmpeg at ${source} does not run.`);
  const lines = info.stdout.split(/\r?\n/);
  const version = lines[0];
  const configuration = lines.find((l) => l.trim().startsWith('configuration:')) || '';
  // The license depends on how FFmpeg was built: --enable-gpl makes the whole build GPL.
  const license = /--enable-gpl/.test(configuration)
    ? 'GPL (this build was configured with --enable-gpl)'
    : 'LGPL (this build was not configured with --enable-gpl)';
  fs.writeFileSync(path.join(stage, 'NOTICE.txt'), [
    'VierVideo uses FFmpeg to encode MP4 video (ffmpeg.exe in this folder).',
    '',
    version,
    `License: ${license}. See https://ffmpeg.org/legal.html`,
    'Source code of FFmpeg: https://ffmpeg.org/download.html',
    '',
  ].join('\n'));
  console.log(`FFmpeg staged from ${source}\n  ${version}`);
}

// The same steps as "npm run build": typecheck, then bundle the renderer.
run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
stageFfmpeg();
stageExamples();

// The configuration: the "build" section of package.json, plus the staged FFmpeg and the output folder.
const config = structuredClone(pkg.build);
config.directories = { ...(config.directories || {}), output: out, buildResources: path.join(root, 'build') };
config.extraResources = [
  ...(config.extraResources || []),
  { from: stage, to: 'ffmpeg', filter: ['ffmpeg.exe', 'NOTICE.txt'] },
  { from: path.join(out, 'stage', 'examples'), to: 'examples' },
];
const configFile = path.join(out, 'electron-builder.json');
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

run(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', '--x64', '--config', configFile]);

const installer = path.join(out, `${pkg.build.productName}-Setup-${pkg.version}.exe`);
if (!fs.existsSync(installer)) fail(`The installer was not written: ${installer}`);
const mb = (fs.statSync(installer).size / 1048576).toFixed(0);
console.log(`\nInstaller written to: ${installer} (${mb} MB)`);
