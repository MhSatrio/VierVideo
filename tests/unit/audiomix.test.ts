import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error plain ESM module without type declarations
import { planAudioMix } from '../../shared/audiomix.mjs';
// @ts-expect-error plain ESM module without type declarations
import { muxArgs, runFfmpeg } from '../../electron/lib/render/mux.mjs';

const clip = (o: object) => ({ id: 'c', track: 'narration', kind: 'audio', start: 0, duration: 2, volume: 1, fadeIn: 0, fadeOut: 0, segmentId: null, assetId: null, ...o });
const tracks = (narration: object[], music: object[] = []) => [
  { id: 'html', clips: [] },
  { id: 'visual', clips: [] },
  { id: 'text', clips: [] },
  { id: 'narration', clips: narration },
  { id: 'music', clips: music },
];

describe('audio mix plan', () => {
  it('has nothing to mix without audio clips', () => {
    expect(planAudioMix(tracks([]), 10)).toEqual({ inputs: [], filter: '' });
  });

  it('delays a narration clip to its start time and reads it from its segment', () => {
    const plan = planAudioMix(tracks([clip({ id: 'n1', segmentId: 'seg001', start: 4, duration: 2.5 })]), 15);
    expect(plan.inputs).toEqual([expect.objectContaining({ clipId: 'n1', source: { type: 'segment', id: 'seg001' } })]);
    expect(plan.filter).toContain('[1:a]atrim=0:2.5');
    expect(plan.filter).toContain('adelay=4000|4000');
    expect(plan.filter).toContain('[a0]anull[sum]');
    expect(plan.filter).toContain('alimiter=limit=0.95[aout]');
  });

  it('sums several clips with amix and keeps each clip volume and fades', () => {
    const plan = planAudioMix(
      tracks(
        [clip({ id: 'n1', segmentId: 'seg001', start: 0, duration: 3, fadeIn: 0.5 })],
        [clip({ id: 'm1', track: 'music', assetId: 'a_tone', start: 0, duration: 10, volume: 0.3, fadeOut: 2 }) as any],
      ),
      15,
    );
    expect(plan.inputs.map((i: any) => i.source)).toEqual([{ type: 'segment', id: 'seg001' }, { type: 'asset', id: 'a_tone' }]);
    expect(plan.filter).toContain('amix=inputs=2:duration=longest:normalize=0');
    expect(plan.filter).toContain('volume=0.3');
    expect(plan.filter).toContain('afade=t=in:st=0:d=0.5');
    expect(plan.filter).toContain('afade=t=out:st=8:d=2');
    expect(plan.filter).not.toContain('adelay=0'); // no delay for a clip at 0
  });

  it('cuts a clip that runs past the end of the project', () => {
    const plan = planAudioMix(tracks([clip({ id: 'n1', segmentId: 's', start: 14, duration: 5 })]), 15);
    expect(plan.filter).toContain('atrim=0:1');
  });

  it('ignores a clip that starts after the project ends', () => {
    expect(planAudioMix(tracks([clip({ id: 'late', segmentId: 's', start: 20, duration: 2 })]), 15).inputs).toEqual([]);
  });
});

describe('muxing the mix into the video', () => {
  it('copies the video, encodes the audio, and cuts to the project length', () => {
    const args = muxArgs({ videoFile: 'v.mp4', audioFiles: ['a.wav', 'b.mp3'], filter: 'F', outFile: 'out.mp4', durationSec: 15 });
    const joined = args.join(' ');
    expect(joined).toContain('-i v.mp4 -i a.wav -i b.mp3');
    expect(joined).toContain('-map 0:v -map [aout] -c:v copy -c:a aac');
    expect(args[args.indexOf('-t') + 1]).toBe('15');
    expect(args[args.length - 1]).toBe('out.mp4');
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasFfmpeg || !hasFfprobe)('muxing with FFmpeg', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-mux-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('puts a tone of the right length into a silent video', async () => {
    const video = path.join(dir, 'video.mp4');
    const tone = path.join(dir, 'tone.wav');
    const out = path.join(dir, 'out.mp4');
    expect(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]).status).toBe(0);
    expect(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', tone]).status).toBe(0);
    const plan = planAudioMix(tracks([], [clip({ id: 'm', track: 'music', assetId: 'tone', start: 1, duration: 2, volume: 0.5 }) as any]), 3);
    await runFfmpeg('ffmpeg', muxArgs({ videoFile: video, audioFiles: [tone], filter: plan.filter, outFile: out, durationSec: 3 }));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', out], { encoding: 'utf8' });
    const j = JSON.parse(probe.stdout);
    expect(j.streams.map((s: any) => s.codec_type).sort()).toEqual(['audio', 'video']);
    expect(j.streams.find((s: any) => s.codec_type === 'audio').codec_name).toBe('aac');
    expect(Math.abs(Number(j.format.duration) - 3)).toBeLessThan(0.1);
  }, 60000);
});

describe('mixing the timeline sound for the preview', () => {
  it('writes one WAV file of the project length, in the same mix as the export', async () => {
    const { mixArgs } = await import('../../electron/lib/render/mux.mjs');
    const args = mixArgs({ audioFiles: ['a.wav'], filter: 'F', outFile: 'out.wav', durationSec: 15 });
    const joined = args.join(' ');
    expect(joined).toContain('-i a.wav -filter_complex F -map [aout]');
    expect(joined).toContain('-t 15 -ar 48000 -ac 2 -c:a pcm_s16le -f wav');
    expect(args[args.length - 1]).toBe('out.wav');
  });
});

describe.skipIf(!hasFfmpeg || !hasFfprobe)('mixing the timeline sound with FFmpeg', () => {
  it('mixes a narration clip and a music clip, as the timeline places them, into a WAV of the project length', async () => {
    const { mixArgs } = await import('../../electron/lib/render/mux.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-mixpreview-'));
    try {
      const a = path.join(dir, 'a.wav');
      const b = path.join(dir, 'b.wav');
      const out = path.join(dir, 'mix.wav');
      expect(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', a]).status).toBe(0);
      expect(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=100:duration=2', b]).status).toBe(0);
      // Narration first (input 1), music second (input 2), as the timeline lists them.
      const plan = planAudioMix(
        [
          { id: 'narration', clips: [clip({ id: 'n1', track: 'narration', segmentId: 'seg001', start: 0.5, duration: 1 })] },
          { id: 'music', clips: [clip({ id: 'm1', track: 'music', assetId: 'tone', start: 0, duration: 2, volume: 0.5 }) as any] },
        ],
        3,
      );
      await runFfmpeg('ffmpeg', mixArgs({ audioFiles: [a, b], filter: plan.filter, outFile: out, durationSec: 3 }));
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', out], { encoding: 'utf8' });
      const j = JSON.parse(probe.stdout);
      expect(j.streams[0].codec_name).toBe('pcm_s16le');
      expect(Math.abs(Number(j.format.duration) - 3)).toBeLessThan(0.05);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
