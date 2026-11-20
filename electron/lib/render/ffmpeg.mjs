// FFmpeg: finding the binary and streaming PNG frames into an H.264 MP4.
// No machine-specific path is hard-coded. Candidates come from the caller (settings, environment, bundle, PATH).
import { spawn } from 'node:child_process';
import { exists } from '../fsx.mjs';

/** Runs `ffmpeg -version`. Resolves with the first line of output, or null if the binary does not work. */
export function probeFfmpeg(bin, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    let proc;
    try {
      proc = spawn(bin, ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
    proc.stdout.on('data', (d) => {
      out += d;
    });
    proc.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 && out.startsWith('ffmpeg') ? out.split('\n')[0].trim() : null);
    });
  });
}

/**
 * Picks the first working FFmpeg from the candidates, in order.
 * @param {Array<{source: string, path: string | null}>} candidates  path may be a bare command name such as "ffmpeg"
 * @returns {Promise<{path: string, source: string, version: string} | null>}
 */
export async function findFfmpeg(candidates) {
  for (const c of candidates) {
    if (!c.path) continue;
    const isFile = c.path.includes('/') || c.path.includes('\\') || /^[a-zA-Z]:/.test(c.path);
    if (isFile && !(await exists(c.path))) continue;
    const version = await probeFfmpeg(c.path);
    if (version) return { path: c.path, source: c.source, version };
  }
  return null;
}

/** H.264 + yuv420p for every player; frames are PNG on stdin at the given rate. */
export function encoderArgs({ fps, outFile }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-movflags', '+faststart',
    '-f', 'mp4', // explicit: the temporary name ends in .part, which FFmpeg cannot map to a container
    outFile,
  ];
}

/**
 * Starts an encoder. write() applies back-pressure; finish() closes the input and waits for FFmpeg;
 * kill() stops it at once.
 */
export function startEncoder({ ffmpegPath, fps, outFile }) {
  const proc = spawn(ffmpegPath, encoderArgs({ fps, outFile }), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  proc.stdin.on('error', () => {
    /* a dead encoder shows up as a failed exit below */
  });
  let exitCode = null;
  const exited = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      exitCode = code;
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg stopped with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ') || 'no message'}`));
    });
  });
  exited.catch(() => {});

  return {
    async write(buf) {
      if (exitCode !== null) throw new Error('The encoder has stopped.');
      if (!proc.stdin.write(buf)) {
        if (process.env.VV_DEBUG === '1') console.error('[ffmpeg] back-pressure: waiting for drain');
        await new Promise((resolve) => {
          const done = () => resolve();
          proc.stdin.once('drain', done);
          proc.once('close', done);
        });
        if (process.env.VV_DEBUG === '1') console.error('[ffmpeg] drained');
      }
      if (exitCode !== null) throw new Error('The encoder has stopped.');
    },
    async finish() {
      proc.stdin.end();
      await exited;
    },
    kill() {
      if (exitCode === null) proc.kill();
    },
    /** Resolves once FFmpeg has exited (so the output file can be removed on Windows). */
    wait() {
      return exited.catch(() => {});
    },
  };
}
