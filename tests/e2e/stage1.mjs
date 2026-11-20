// Stage 1 end-to-end test: drives the real Electron app over the Chrome DevTools protocol.
// Run:  npm run build && node tests/e2e/stage1.mjs
// Native file dialogs are replaced by window.vv.e2eSetPicks (only honoured when VV_E2E=1).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const electronExe = require('electron'); // path to electron.exe
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDP_PORT = 9339;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e-'));
const parent = path.join(work, 'projects');
const userData = path.join(work, 'user-data');
const fixtures = path.join(work, 'fixtures');
const PROJECT_DIR = path.join(parent, 'FTIR test');
fs.mkdirSync(parent, { recursive: true });
fs.mkdirSync(fixtures, { recursive: true });

const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a6b5e5c40000000049454e44ae426082', 'hex');
const files = {
  png: path.join(fixtures, 'frame.png'),
  svg: path.join(fixtures, 'logo.svg'),
  md: path.join(fixtures, 'notes.md'),
  html: path.join(fixtures, 'anim.html'),
  exe: path.join(fixtures, 'setup.exe'),
  txt: path.join(fixtures, 'extra.txt'),
};
fs.writeFileSync(files.png, PNG_1x1);
fs.copyFileSync(path.join(ROOT, 'public', 'icon.svg'), files.svg);
fs.writeFileSync(files.md, '# Hook\nEvery molecule is constantly vibrating.\n');
fs.writeFileSync(files.html, '<!doctype html><body><p id="probe"></p><script>document.getElementById("probe").textContent = "vv-html-ok";</script></body>');
fs.writeFileSync(files.exe, 'MZ not a real program');
fs.writeFileSync(files.txt, 'Narration draft for the test.');
const originalsBefore = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f).toString('base64')]));

let proc = null;
let browser = null;
let page = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const readDoc = () => JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.vvproj.json'), 'utf8'));

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    throw err;
  }
}

async function launch() {
  const env = { ...process.env, VV_E2E: '1', VV_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE; // VS Code sets this; it would turn Electron into plain Node
  proc = spawn(electronExe, [ROOT, `--remote-debugging-port=${CDP_PORT}`], { stdio: ['ignore', 'ignore', 'pipe'], env, cwd: ROOT });
  proc.stderr.on('data', (d) => {
    if (process.env.VV_DEBUG) process.stderr.write(String(d));
  });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      break;
    } catch {
      await sleep(400);
    }
  }
  assert(browser, 'could not connect to Electron over CDP');
  const ctx = browser.contexts()[0];
  page = ctx.pages()[0] ?? (await ctx.waitForEvent('page'));
  await page.waitForLoadState('domcontentloaded');
}

async function stop() {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  browser = null;
  if (proc && proc.exitCode === null) {
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      setTimeout(resolve, 8000);
    });
  }
  proc = null;
  await sleep(800);
}

const setPicks = (p) => page.evaluate((x) => window.vv.e2eSetPicks(x), p);
const statusText = () => page.locator('.status-line').first().innerText();
const cards = () => page.locator('.asset-card');
// Optional screenshots for a visual check: VV_SHOTS=<folder>
const shot = async (name) => {
  if (process.env.VV_SHOTS) await page.screenshot({ path: path.join(process.env.VV_SHOTS, `${name}.png`) });
};

let failed = false;
try {
  console.log('VierVideo stage 1 end-to-end');
  await launch();

  await step('start screen is shown with new and open actions', async () => {
    await page.locator('.start').waitFor();
    await page.getByRole('button', { name: 'New project' }).waitFor();
    await page.getByRole('button', { name: 'Open project' }).waitFor();
  });

  await step('creating a project writes a project file and an assets folder', async () => {
    await setPicks({ folder: parent });
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill('FTIR test');
    await page.getByRole('button', { name: 'Choose folder' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.locator('.app').waitFor();
    const doc = readDoc();
    assert(doc.format === 'viervideo-project' && doc.name === 'FTIR test', 'project file has the wrong content');
    assert(doc.settings.aspect === '9:16' && doc.settings.fps === 30, 'default settings were not saved');
    assert(fs.existsSync(path.join(PROJECT_DIR, 'assets')), 'assets folder missing');
  });

  await step('creating a project in a non-empty folder is refused inside the dialog', async () => {
    await page.locator('.topbar').getByRole('button', { name: 'Close project' }).click();
    await page.getByRole('button', { name: 'New project' }).waitFor();
    await setPicks({ folder: parent });
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill('FTIR test');
    await page.getByRole('button', { name: 'Choose folder' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('alert').filter({ hasText: 'not empty' }).waitFor();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'New project' }).waitFor();
    // Reopen the project for the rest of the test.
    await page.locator('.recent-item button.open', { hasText: 'FTIR test' }).click();
    await page.locator('.app').waitFor();
  });

  await step('importing files copies them into the project and lists them', async () => {
    await setPicks({ files: [files.png, files.svg, files.md, files.html] });
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await page.locator('.asset-card').nth(3).waitFor();
    assert((await cards().count()) === 4, `expected 4 assets, got ${await cards().count()}`);
    assert((await statusText()).includes('Imported 4 files'), `unexpected status: ${await statusText()}`);
  });

  await step('the same file again is reported as already in the project, not copied twice', async () => {
    await setPicks({ files: [files.png] });
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await page.waitForFunction(() => document.querySelector('.status-line')?.textContent?.includes('already in the project'));
    assert((await cards().count()) === 4, 'duplicate was added');
    assert(fs.readdirSync(path.join(PROJECT_DIR, 'assets')).length === 4, 'duplicate was copied to assets');
  });

  await step('unsupported files are skipped with the reason shown as an error', async () => {
    await setPicks({ files: [files.exe] });
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await page.locator('.status-line.error').waitFor();
    assert((await statusText()).includes('unsupported file type'), 'reason not shown');
    assert((await cards().count()) === 4, 'unsupported file was added');
  });

  await step('image preview renders through the vvasset scheme', async () => {
    await page.locator('.asset-card', { hasText: 'frame.png' }).click();
    await page.waitForFunction(() => {
      const img = document.querySelector('.frame img');
      return !!img && img.complete && img.naturalWidth > 0;
    });
    const src = await page.locator('.frame img').getAttribute('src');
    assert(src.startsWith('vvasset://asset/'), `unexpected preview source ${src}`);
    await shot('project-image');
  });

  await step('script preview shows the file text (read through IPC)', async () => {
    await page.locator('.asset-card', { hasText: 'notes.md' }).click();
    await page.locator('.text-view', { hasText: 'Every molecule is constantly vibrating.' }).waitFor();
  });

  await step('HTML animation previews as a frame rendered by the engine', async () => {
    // Stage 2 replaced the live iframe with frame-accurate renders. This page never asks for an animation
    // frame, so the render also reports that.
    await page.locator('.asset-card', { hasText: 'anim.html' }).click();
    await page.waitForFunction(() => document.querySelector('.frame img')?.getAttribute('src')?.startsWith('data:image/png;base64,'), null, { timeout: 60000 });
    await page.locator('.preview-warning', { hasText: 'never asked for an animation frame' }).waitFor({ timeout: 30000 });
    assert((await page.locator('.frame iframe').count()) === 0, 'an iframe is still shown for HTML');
  });

  await step('folders: create, select, and import into the selected folder', async () => {
    await page.getByRole('button', { name: 'New folder' }).click();
    await page.getByLabel('New folder name').fill('Logos');
    await page.getByLabel('New folder name').press('Enter');
    await page.locator('.folder-bar .chip', { hasText: 'Logos' }).waitFor();
    await page.locator('.folder-bar .chip', { hasText: 'Logos' }).click();
    await setPicks({ files: [files.txt] });
    await page.locator('.topbar').getByRole('button', { name: 'Import' }).click();
    await page.waitForFunction(() => /Logos\s+1/.test(document.querySelector('.folder-bar')?.textContent ?? ''));
    assert(readDoc().assets.find((a) => a.name === 'extra.txt')?.folderId, 'imported file is not in the folder');
  });

  await step('folders: duplicate names are refused', async () => {
    await page.getByRole('button', { name: 'New folder' }).click();
    await page.getByLabel('New folder name').fill('logos');
    await page.getByLabel('New folder name').press('Enter');
    await page.locator('.status-line.error').waitFor();
    assert((await statusText()).includes('already exists'), 'no duplicate-folder message');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('assets can be renamed and moved to a folder from the inspector', async () => {
    await page.locator('.folder-bar .chip', { hasText: 'All' }).click();
    await page.locator('.asset-card', { hasText: 'frame.png' }).click();
    await page.getByLabel('Asset name').fill('Hero frame');
    await page.getByLabel('Asset name').press('Enter');
    await page.locator('.asset-card', { hasText: 'Hero frame' }).waitFor();
    await page.getByLabel('Move to folder').selectOption({ label: 'Logos' });
    await page.waitForFunction(() => /Logos\s+2/.test(document.querySelector('.folder-bar')?.textContent ?? ''));
    const doc = readDoc();
    assert(doc.assets.find((a) => a.name === 'Hero frame')?.folderId, 'move was not saved');
    assert(doc.assets.find((a) => a.name === 'Hero frame')?.originalName === 'frame.png', 'original name changed');
  });

  await step('project settings: aspect ratio, frame rate and duration are saved', async () => {
    await page.locator('.asset-card[aria-pressed="true"]').click(); // clear the selection
    await page.getByRole('radio', { name: /16:9/ }).click();
    await page.getByRole('button', { name: '60 fps' }).click();
    await page.locator('.timeline-tools').getByLabel('Timeline duration in seconds').fill('90');
    await page.locator('.timeline-tools').getByRole('button', { name: 'Set' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid=composition-frame]')?.style.getPropertyValue('--w') === '1920');
    const doc = readDoc();
    assert(doc.settings.aspect === '16:9' && doc.settings.fps === 60 && doc.settings.durationSec === 90, `settings on disk: ${JSON.stringify(doc.settings)}`);
    assert(doc.timeline.durationSec === 90, 'timeline duration not updated');
    await shot('project-settings');
  });

  await step('the original imported files are untouched', async () => {
    for (const [k, f] of Object.entries(files)) {
      assert(fs.readFileSync(f).toString('base64') === originalsBefore[k], `original ${k} changed`);
    }
  });

  await step('the About dialog names VierApparatus as developer', async () => {
    await page.locator('.topbar').getByRole('button', { name: 'About' }).click();
    await page.getByRole('dialog').getByText('VierApparatus', { exact: false }).first().waitFor();
    await page.getByRole('dialog').getByText('Developer:', { exact: false }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  });

  await step('the renderer cannot read files outside the project', async () => {
    const message = await page.evaluate(() => window.vv.readText('../../secret').then(() => 'read', (e) => e.message));
    assert(message.includes('no longer in the project'), `unexpected result: ${message}`);
  });

  await step('removing an asset deletes only its copy; the original stays', async () => {
    const before = readDoc();
    const html = before.assets.find((a) => a.name === 'anim.html');
    const copy = path.join(PROJECT_DIR, html.file);
    assert(fs.existsSync(copy), 'copy missing before removal');
    await page.locator('.asset-card', { hasText: 'anim.html' }).click();
    await page.getByRole('button', { name: 'Remove from project' }).click();
    await page.getByRole('button', { name: 'Click again to remove' }).click();
    // 4 imported files + extra.txt, minus the removed html file = 4 assets
    await page.waitForFunction(() => document.querySelectorAll('.asset-card').length === 4);
    assert(!fs.existsSync(copy), 'copy still in the project folder');
    assert(fs.existsSync(files.html), 'original file was deleted');
    assert(before.assets.length === 5, `expected 5 assets before removal, got ${before.assets.length}`);
  });

  await step('save now reports that the project is saved', async () => {
    await page.locator('.topbar').getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.status-line')?.textContent?.includes('Saved.'));
  });

  await step('closing the project returns to the start screen, which lists it as recent', async () => {
    await page.locator('.topbar').getByRole('button', { name: 'Close project' }).click();
    await page.locator('.recent-item', { hasText: 'FTIR test' }).waitFor();
  });

  // ---- restart: everything must come back from disk
  await stop();
  await step('a missing file is detected after restart and shown in the library', async () => {
    const svgAsset = readDoc().assets.find((a) => a.name === 'logo.svg');
    fs.rmSync(path.join(PROJECT_DIR, svgAsset.file));
  });

  await launch();
  await step('after restart the recent project opens with the same content', async () => {
    await page.locator('.recent-item', { hasText: 'FTIR test' }).getByRole('button').first().click();
    await page.locator('.app').waitFor();
    assert((await cards().count()) === 4, `expected 4 assets, got ${await cards().count()}`);
    const doc = readDoc();
    assert(doc.settings.aspect === '16:9' && doc.settings.fps === 60 && doc.settings.durationSec === 90, 'settings were not kept');
    const logos = doc.folders.find((f) => f.name === 'Logos');
    assert(logos && doc.assets.filter((a) => a.folderId === logos.id).length === 2, 'folder contents were not kept');
  });

  await step('the missing file is flagged in the library', async () => {
    await page.locator('.asset-card .badge.warn', { hasText: 'Missing file' }).waitFor();
    await page.locator('.asset-card', { hasText: 'logo.svg' }).click();
    await page.locator('.frame .placeholder', { hasText: 'File missing' }).waitFor();
  });

  await step('a damaged project file is reported clearly, not crashed on', async () => {
    await page.locator('.topbar').getByRole('button', { name: 'Close project' }).click();
    fs.writeFileSync(path.join(PROJECT_DIR, 'project.vvproj.json'), '{ broken');
    await page.getByRole('button', { name: 'Open project' }).waitFor();
    await page.locator('.recent-item', { hasText: 'FTIR test' }).waitFor();
    await shot('start-with-recent');
    await page.locator('.recent-item', { hasText: 'FTIR test' }).getByRole('button').first().click();
    await page.locator('.status-line.error').waitFor();
    assert((await statusText()).includes('damaged'), `unexpected message: ${await statusText()}`);
    // restore the project file from the backup written by the atomic save
    fs.copyFileSync(path.join(PROJECT_DIR, 'project.vvproj.json.bak'), path.join(PROJECT_DIR, 'project.vvproj.json'));
  });

  console.log('\nAll Stage 1 end-to-end checks passed.');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await stop();
  if (process.env.VV_KEEP !== '1') fs.rmSync(work, { recursive: true, force: true });
  else console.log('kept', work);
}
process.exit(failed ? 1 : 0);
