// Narration logic shared by the main process and the renderer. Pure functions: no Node or DOM APIs.
// Scripts become segments (text plus an optional start and end in seconds). Each segment is synthesised
// separately, cached by a signature of its text, voice and speed, and placed on the narration track.

/** Voice ids of the local Kokoro voice pack. tools/tts/config.json holds the labels; a test keeps them equal. */
export const VOICE_IDS = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'am_fenrir', 'am_michael', 'bf_emma', 'bm_george'];
export const DEFAULT_VOICE = 'af_heart';
export const SPEED_MIN = 0.7;
export const SPEED_MAX = 1.3;
export const DEFAULT_SPEED = 1.0;
/** Pause between segments that have no timestamp of their own. */
export const SEGMENT_GAP_SEC = 0.25;
/** Unstamped text is grouped into segments of about this many characters. */
export const MAX_SEGMENT_CHARS = 240;
export const SEGMENT_STATUS = ['pending', 'ok', 'stale', 'error'];

// ---------- time helpers

/** "1:05", "00:01:05.5", "65,5" or a number -> seconds. Returns null when it is not a time. */
export function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(',', '.');
  if (!/^\d{1,2}(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

// ---------- script parsing

// Timestamps in scripts have a colon ("0:05", "00:01:05.5"), so a line like "2-3 things" is not read as a range.
const TIME = '\\d{1,2}:\\d{1,2}(?::\\d{1,2})?(?:[.,]\\d+)?';
const TIMED_RANGE = new RegExp(`^\\s*\\[?\\s*(${TIME})\\s*(?:-|–|—|→|->|to)\\s*(${TIME})\\s*\\]?\\s*[:|\\-–—]?\\s*(.*)$`);
const TIMED_START = new RegExp(`^\\s*\\[\\s*(${TIME})\\s*\\]\\s*[:|\\-–—]?\\s*(.*)$`);
const CUE = new RegExp(`^\\s*(${TIME})\\s*-->\\s*(${TIME})`);

function cleanText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Plain text -> chunks of whole sentences of at most `max` characters. Paragraphs are never merged. */
export function splitPlain(text, max = MAX_SEGMENT_CHARS) {
  const out = [];
  const paragraphs = String(text)
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((p) => cleanText(p.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s+|\d+[.)]\s+)/gm, '')))
    .filter(Boolean);
  for (const para of paragraphs) {
    const sentences = para.split(/(?<=[.!?])\s+/).filter(Boolean);
    let cur = '';
    for (const s of sentences) {
      if (cur && (cur + ' ' + s).length > max) {
        out.push(cur);
        cur = s;
      } else {
        cur = cur ? cur + ' ' + s : s;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Strips the markdown that would be read aloud (emphasis, links, code, rules). */
export function stripMarkdown(md) {
  return String(md)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1');
}

function parseTimedLines(lines) {
  const segments = [];
  const warnings = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const range = TIMED_RANGE.exec(line);
    const start = range ? parseTime(range[1].replace(/,/g, '.')) : null;
    const end = range ? parseTime(range[2].replace(/,/g, '.')) : null;
    const startOnly = !range ? TIMED_START.exec(line) : null;
    const one = startOnly ? parseTime(startOnly[1]) : null;
    if (range && start !== null && end !== null) {
      segments.push({ start, end, text: cleanText(range[3]) });
    } else if (startOnly && one !== null) {
      segments.push({ start: one, end: null, text: cleanText(startOnly[2]) });
    } else if (segments.length) {
      // a line without a timestamp continues the previous segment
      segments[segments.length - 1].text = cleanText(segments[segments.length - 1].text + ' ' + line);
    } else {
      warnings.push(`Skipped text before the first timestamp: "${cleanText(line).slice(0, 40)}"`);
    }
  }
  return { segments: segments.filter((s) => s.text), warnings };
}

function parseCues(text) {
  const segments = [];
  const warnings = [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = CUE.exec(lines[i]);
    if (!m) continue;
    const start = parseTime(m[1].replace(/,/g, '.'));
    const end = parseTime(m[2].replace(/,/g, '.'));
    const body = [];
    for (let j = i + 1; j < lines.length && lines[j].trim(); j++) body.push(lines[j].trim());
    const t = cleanText(body.join(' '));
    if (start !== null && end !== null && t) segments.push({ start, end, text: t });
    else warnings.push(`A cue at line ${i + 1} has no usable time or text.`);
  }
  return { segments, warnings };
}

function fromItems(items) {
  const segments = [];
  const warnings = [];
  items.forEach((item, i) => {
    if (typeof item === 'string') {
      for (const t of splitPlain(item)) segments.push({ start: null, end: null, text: t });
      return;
    }
    if (!item || typeof item !== 'object') return warnings.push(`Item ${i + 1} is not text or an object.`);
    const text = cleanText(item.text ?? item.narration ?? item.line ?? item.script ?? '');
    if (!text) return warnings.push(`Item ${i + 1} has no text.`);
    const start = parseTime(item.start ?? item.startSec ?? item.from ?? item.time ?? null);
    const end = parseTime(item.end ?? item.endSec ?? item.to ?? null);
    segments.push({ start, end, text });
  });
  return { segments, warnings };
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { segments: [], warnings: [`The JSON file is not valid: ${err.message}`] };
  }
  if (Array.isArray(data)) return fromItems(data);
  if (data && typeof data === 'object') {
    for (const key of ['segments', 'narration', 'lines', 'script', 'items']) {
      if (Array.isArray(data[key])) return fromItems(data[key]);
    }
    if (typeof data.text === 'string') return fromItems([data]);
  }
  return { segments: [], warnings: ['The JSON file needs an array of segments (text, with optional start and end).'] };
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function parseCsv(text) {
  const rows = parseCsvRows(String(text).replace(/^﻿/, ''));
  if (!rows.length) return { segments: [], warnings: ['The CSV file is empty.'] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = header.includes('text') || header.includes('narration');
  const idx = (name, fallback) => (hasHeader && header.indexOf(name) >= 0 ? header.indexOf(name) : fallback);
  const iStart = idx('start', 0);
  const iEnd = idx('end', 1);
  const iText = hasHeader ? (header.includes('text') ? header.indexOf('text') : header.indexOf('narration')) : 2;
  const body = hasHeader ? rows.slice(1) : rows;
  const segments = [];
  const warnings = [];
  body.forEach((r, i) => {
    const text = cleanText(r[iText] ?? '');
    if (!text) return warnings.push(`Row ${i + 1} has no text.`);
    const start = parseTime(r[iStart] ?? '');
    const end = parseTime(r[iEnd] ?? '');
    segments.push({ start, end, text });
  });
  return { segments, warnings };
}

/**
 * Parses a script into segments. The format is taken from the file extension, then from the content.
 * @returns {{format: string, segments: Array<{start: number|null, end: number|null, text: string}>, warnings: string[]}}
 */
export function parseScript(text, ext = '') {
  const e = String(ext).toLowerCase();
  const body = String(text ?? '');
  if (e === '.json') return { format: 'json', ...parseJson(body) };
  if (e === '.csv') return { format: 'csv', ...parseCsv(body) };
  if (/^﻿?WEBVTT/.test(body) || CUE.test(body.split('\n').find((l) => CUE.test(l)) ?? '')) {
    const out = parseCues(body);
    if (out.segments.length) return { format: /WEBVTT/.test(body) ? 'vtt' : 'srt', ...out };
  }
  const plainBody = e === '.md' || e === '.markdown' ? stripMarkdown(body) : body;
  const lines = plainBody.split('\n');
  const timed = lines.filter((l) => TIMED_RANGE.test(l) || TIMED_START.test(l)).length;
  if (timed > 0) return { format: 'timed', ...parseTimedLines(lines) };
  const segments = splitPlain(plainBody).map((t) => ({ start: null, end: null, text: t }));
  return { format: 'plain', segments, warnings: segments.length ? [] : ['The script has no text.'] };
}

// ---------- segments and layout

/** Numbers segments in order and gives each a stable id. Timed segments are sorted by start. */
export function buildSegments(parsed) {
  const timed = parsed.segments.some((s) => s.start !== null);
  const list = timed ? [...parsed.segments].sort((a, b) => (a.start ?? 0) - (b.start ?? 0)) : parsed.segments;
  return list
    .filter((s) => s.text && s.text.trim())
    .map((s, i) => ({
      id: `seg${String(i + 1).padStart(3, '0')}`,
      index: i + 1,
      start: s.start ?? null,
      end: s.end ?? null,
      text: s.text.trim(),
      status: 'pending',
      file: null,
      durationSec: null,
      signature: null,
      error: null,
    }));
}

/** Start time of every segment on the timeline. Timed segments keep their time; others follow the previous one. */
export function layoutStarts(segments, durations) {
  const starts = [];
  let cursor = 0;
  segments.forEach((s, i) => {
    const start = s.start !== null ? s.start : cursor;
    starts.push(start);
    const d = durations[i] ?? 0;
    cursor = Math.max(cursor, start + d) + SEGMENT_GAP_SEC;
  });
  return starts;
}

/**
 * Timing problems for timed segments: a clip that runs into the next one, or past its own end time.
 * @returns {Array<{id: string, message: string}>}
 */
export function timingWarnings(segments) {
  const out = [];
  segments.forEach((s, i) => {
    if (s.status !== 'ok' || s.durationSec == null || s.start === null) return;
    if (s.end !== null && s.start + s.durationSec > s.end + 0.05) {
      out.push({ id: s.id, message: `Segment ${s.index} is ${s.durationSec.toFixed(1)} s but its slot ends after ${(s.end - s.start).toFixed(1)} s. Shorten the text or move the end time.` });
    }
    const next = segments.slice(i + 1).find((n) => n.start !== null);
    if (next && next.start < s.start + s.durationSec - 0.05) {
      out.push({ id: s.id, message: `Segment ${s.index} runs into segment ${next.index} by ${(s.start + s.durationSec - next.start).toFixed(1)} s.` });
    }
  });
  return out;
}

// ---------- signatures (cache keys)

/** Small, stable, non-cryptographic hash (FNV-1a, 32 bits) of a string, as 8 hex digits. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Bump when the synthesis or pronunciation rules change, so cached audio is regenerated. */
export const SYNTH_VERSION = 'kokoro-82m/batch6-rules-1';

/** Cache key for one segment: the audio changes when the text, voice, speed or synthesis version changes. */
export function segmentSignature({ text, voice, speed }) {
  return hashString(JSON.stringify([SYNTH_VERSION, text, voice, Number(speed).toFixed(3)])) + hashString(text);
}

export function isValidVoice(id) {
  return VOICE_IDS.includes(id);
}

export function clampSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SPEED;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(n * 100) / 100));
}
