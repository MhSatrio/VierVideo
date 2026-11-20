// Final render (Stage 5): puts the mixed audio into the video. The video stream is copied, not re-encoded,
// so this step is quick and the picture is exactly the one that was rendered.
import { spawn } from 'node:child_process';

/**
 * @param {{videoFile: string, audioFiles: string[], filter: string, outFile: string, durationSec: number}} o
 *   audioFiles[i] is ffmpeg input i+1; the filter refers to them by that index.
 */
export function muxArgs(o) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', o.videoFile];
  for (const f of o.audioFiles) args.push('-i', f);
  args.push(
    '-filter_complex', o.filter,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-t', String(o.durationSec),
    '-movflags', '+faststart',
    '-f', 'mp4', // explicit: the temporary names do not carry the container
    o.outFile,
  );
  return args;
}

/**
 * Mixes the audio of the timeline into one WAV file, for playing the preview with sound. It is the same mix as the
 * export (same filter), so what is heard in the preview is what the video will have.
 * @param {{audioFiles: string[], filter: string, outFile: string, durationSec: number}} o
 */
export function mixArgs(o) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  // Input 0 is silence that the filter does not use: the timeline's filter numbers its audio inputs from 1, as the export
  // does (there, input 0 is the video). Without it, the first audio file would be input 0 and the filter would not bind.
  args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  for (const f of o.audioFiles) args.push('-i', f);
  args.push(
    '-filter_complex', o.filter,
    '-map', '[aout]',
    '-t', String(o.durationSec),
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    o.outFile,
  );
  return args;
}

/** Runs FFmpeg with the given arguments. Rejects with the last lines of FFmpeg's message on failure. */
export function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    proc.on('error', (err) => reject(new Error(`FFmpeg did not start: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg stopped with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ') || 'no message'}`));
    });
  });
}
