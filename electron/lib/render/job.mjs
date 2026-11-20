// A render job: frames from a session -> FFmpeg -> MP4. Independent of Electron (the session is injected),
// so the frame loop, progress and cancellation can be unit tested.
import fs from 'node:fs/promises';
import { startEncoder } from './ffmpeg.mjs';

export class RenderCancelled extends Error {
  constructor() {
    super('The export was cancelled.');
    this.name = 'RenderCancelled';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {(opts: {mode: string}) => Promise<{frame(ms: number): Promise<Buffer>, close(): Promise<void>, warnings: string[]}>} o.openSession
 * @param {string} o.outFile          final MP4 path; written as <outFile>.part first
 * @param {string} o.ffmpegPath
 * @param {number} o.fps
 * @param {number} o.durationSec
 * @param {'deterministic'|'realtime'} o.mode
 * @param {AbortSignal} [o.signal]
 * @param {(p: {frame: number, total: number, percent: number}) => void} [o.onProgress]
 */
export async function renderVideo(o) {
  const total = Math.max(1, Math.round(o.durationSec * o.fps));
  const part = o.outFile + '.part';
  const session = await o.openSession({ mode: o.mode });
  let encoder = null;
  try {
    encoder = startEncoder({ ffmpegPath: o.ffmpegPath, fps: o.fps, outFile: part });
    const started = Date.now();
    for (let i = 0; i < total; i++) {
      if (o.signal?.aborted) throw new RenderCancelled();
      const tMs = (i * 1000) / o.fps;
      if (o.mode === 'realtime') {
        // Real-time capture: wait for the moment this frame belongs to. Slow captures make the video run late.
        const wait = started + tMs - Date.now();
        if (wait > 0) await sleep(wait);
      }
      const png = await session.frame(tMs);
      await encoder.write(png);
      if (o.onProgress) {
        const frame = i + 1;
        o.onProgress({ frame, total, percent: Math.round((frame / total) * 100) });
      }
    }
    if (o.signal?.aborted) throw new RenderCancelled();
    await encoder.finish();
    encoder = null;
    await fs.rename(part, o.outFile);
    const st = await fs.stat(o.outFile);
    return { file: o.outFile, frames: total, bytes: st.size, warnings: session.warnings ?? [] };
  } catch (err) {
    if (encoder) {
      encoder.kill();
      await encoder.wait();
    }
    await fs.rm(part, { force: true }).catch(() => {});
    throw err;
  } finally {
    await session.close().catch(() => {});
  }
}
