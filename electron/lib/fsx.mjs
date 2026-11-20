// File helpers for the main process: safe names, containment checks, hashing and atomic JSON writes.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A single safe file or folder name (Windows and POSIX rules). */
export function safeName(input, fallback = 'item') {
  let s = String(input ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!s) s = fallback;
  if (WINDOWS_RESERVED.test(s.split('.')[0])) s = '_' + s;
  return s.slice(0, 120);
}

/** Resolve `rel` under `root`. Throws if the result would leave `root`. */
export function resolveInside(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('That path is outside the project folder.');
  }
  return abs;
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Write JSON to a temp file, keep the previous version as .bak, then rename over the target. */
export async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.copyFile(file, file + '.bak');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.rename(tmp, file);
}

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
