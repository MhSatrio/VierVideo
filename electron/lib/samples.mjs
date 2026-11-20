// Sample sounds for the example project. They are generated here, so no sound file has to be shipped or downloaded.

/**
 * A complete WAV file (16-bit mono PCM).
 * @param {number} seconds
 * @param {(t: number) => number} sample  value from -1 to 1 at time t (seconds)
 * @param {number} [rate=24000]
 * @returns {Buffer}
 */
export function wavFile(seconds, sample, rate = 24000) {
  const n = Math.max(1, Math.round(seconds * rate));
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, Number(sample(i / rate)) || 0));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM format chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per frame
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A soft chime for the start of the example: two partials that fade out within about 2.5 s. */
export function chimeSample(t) {
  if (t < 0 || t > 2.5) return 0;
  return (0.5 * Math.sin(2 * Math.PI * 880 * t) + 0.2 * Math.sin(2 * Math.PI * 1320 * t)) * Math.exp(-2.2 * t);
}

/** A quiet drone under the whole example: a low chord that breathes slowly. */
export function droneSample(t) {
  const breath = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.08 * t);
  const chord = Math.sin(2 * Math.PI * 110 * t) + 0.6 * Math.sin(2 * Math.PI * 165 * t) + 0.4 * Math.sin(2 * Math.PI * 220 * t);
  return (0.3 * breath * chord) / 2;
}
