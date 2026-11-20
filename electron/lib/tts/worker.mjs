// Narration engine: finds a Python with Kokoro installed and runs tools/tts/worker.py as a child process.
// Requests and replies are JSON lines (see the header of worker.py). One request runs at a time.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { exists } from '../fsx.mjs';

/** Where to look for Python, in order. Nothing is hard-coded: the venv default is built from LOCALAPPDATA. */
export function pythonCandidates({ settingsPython, env = process.env, platform = process.platform }) {
  const venvPython = platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
  const localData = platform === 'win32' ? env.LOCALAPPDATA : env.HOME ? path.join(env.HOME, '.local', 'share') : null;
  return [
    { source: 'settings', path: settingsPython ?? null },
    { source: 'VIERVIDEO_PYTHON', path: env.VIERVIDEO_PYTHON || null },
    { source: 'vier-tts venv', path: localData ? path.join(localData, 'vier-tts', 'venv', venvPython) : null },
  ];
}

export async function findPython(candidates) {
  for (const c of candidates) {
    if (!c.path) continue;
    if (!(await exists(c.path))) continue;
    const info = probePython(c.path);
    if (info) return { path: c.path, source: c.source, version: info };
  }
  return null;
}

/** Runs `python -c` to confirm the interpreter starts. Returns its version line, or null. */
export function probePython(bin) {
  try {
    const r = spawnSync(bin, ['-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.status !== 0) return null;
    return String(r.stdout).trim() || null;
  } catch {
    return null;
  }
}

export class NarrationWorker {
  /**
   * @param {{python: string, script: string, env?: Record<string, string>}} o
   */
  constructor(o) {
    this.python = o.python;
    this.script = o.script;
    this.extraEnv = o.env ?? {};
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderrTail = '';
  }

  get running() {
    return this.proc !== null;
  }

  start() {
    if (this.proc) return;
    const env = { ...process.env, ...this.extraEnv, PYTHONUTF8: '1', PYTHONWARNINGS: 'ignore', HF_HUB_OFFLINE: '1' };
    const proc = spawn(this.python, [this.script], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.onData(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-3000);
    });
    proc.stdin.on('error', () => {
      /* a stopped worker reports through its exit below */
    });
    proc.on('error', (err) => {
      if (this.proc === proc) this.proc = null;
      this.fail(new Error(`The narration engine did not start: ${err.message}`));
    });
    proc.on('exit', (code) => {
      if (this.proc === proc) {
        this.proc = null;
        const last = this.stderrTail.trim().split('\n').filter(Boolean).pop() ?? '';
        this.fail(new Error(`The narration engine stopped${code === 0 ? '' : ` (code ${code})`}${last ? ': ' + last : '.'}`));
      }
    });
    this.proc = proc;
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not a reply (a stray print); ignore it
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'The narration engine failed.'));
    }
  }

  fail(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Sends one request and resolves with the reply. A timeout stops the engine (it cannot be interrupted). */
  request(op, payload = {}, timeoutMs = 600000) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stop('The narration engine did not answer in time.');
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
    });
  }

  /** Stops the engine process now. Pending requests fail with `reason`. */
  stop(reason = 'The narration engine was stopped.') {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n');
      } catch {
        /* already closed */
      }
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }
    this.fail(new Error(reason));
  }
}
