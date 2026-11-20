// Audio mix plan for the final render (Stage 5). Pure: it turns the narration and music clips of the timeline
// into FFmpeg inputs and one filter graph. The main process maps each input's source to a file and runs FFmpeg.
//
// Each audio clip becomes one input: trimmed to its duration, set to its volume, faded in and out, and delayed
// to its start time. The clips are summed (amix) and limited so that loud parts do not clip.

const fmt = (n) => (Math.round(n * 1000) / 1000).toString();

/**
 * @param {Array<{id: string, track: string, kind: string, start: number, duration: number, volume?: number,
 *   fadeIn?: number, fadeOut?: number, segmentId?: string|null, assetId?: string|null}>} tracks  timeline tracks
 * @param {number} total   project duration in seconds (the mix is cut to it)
 * @returns {{inputs: Array<{clipId: string, source: {type: 'segment'|'asset', id: string}}>, filter: string}}
 */
export function planAudioMix(tracks, total) {
  const clips = tracks
    .filter((t) => t.id === 'narration' || t.id === 'music')
    .flatMap((t) => t.clips)
    .filter((c) => c.kind === 'audio' && c.duration > 0 && c.start < total);
  if (clips.length === 0) return { inputs: [], filter: '' };

  const inputs = clips.map((c) => ({
    clipId: c.id,
    source: c.segmentId ? { type: 'segment', id: c.segmentId } : { type: 'asset', id: c.assetId ?? '' },
    start: c.start,
    duration: c.duration,
    volume: c.volume ?? 1,
    fadeIn: c.fadeIn ?? 0,
    fadeOut: c.fadeOut ?? 0,
  }));

  const chains = inputs.map((c, i) => {
    const d = Math.min(c.duration, total - c.start);
    const parts = [
      `[${i + 1}:a]atrim=0:${fmt(d)}`,
      'asetpts=PTS-STARTPTS',
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      `volume=${fmt(c.volume)}`,
    ];
    const fi = Math.min(c.fadeIn, d);
    const fo = Math.min(c.fadeOut, d);
    if (fi > 0) parts.push(`afade=t=in:st=0:d=${fmt(fi)}`);
    if (fo > 0) parts.push(`afade=t=out:st=${fmt(d - fo)}:d=${fmt(fo)}`);
    const ms = Math.round(c.start * 1000);
    if (ms > 0) parts.push(`adelay=${ms}|${ms}`);
    return `${parts.join(',')}[a${i}]`;
  });

  const labels = inputs.map((_, i) => `[a${i}]`).join('');
  const sum = inputs.length > 1
    ? `${labels}amix=inputs=${inputs.length}:duration=longest:normalize=0[sum]`
    : `${labels}anull[sum]`;
  // The mix is as long as the project: silence is added after the last clip (the mix ends with its longest clip), then cut.
  // The limiter only touches loud peaks.
  const tail = `[sum]apad=whole_dur=${fmt(total)},atrim=0:${fmt(total)},asetpts=PTS-STARTPTS,alimiter=limit=0.95[aout]`;
  return { inputs, filter: [...chains, sum, tail].join(';') };
}
