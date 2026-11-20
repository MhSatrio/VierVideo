"""VierVideo narration worker: Kokoro-82M, local CPU, no network.

Protocol: one JSON request per line on stdin, one JSON reply per line on stdout. Anything else (model
warnings, progress bars) goes to stderr. Requests:
    {"id": 1, "op": "ping"}
    {"id": 2, "op": "voices"}
    {"id": 3, "op": "synth", "text": "...", "voice": "af_heart", "speed": 1.0, "out": "C:/.../clip.wav"}
Replies: {"id": 3, "ok": true, "file": "...", "durationSec": 4.25}  or  {"id": 3, "ok": false, "error": "..."}

Synthesis is ported from vier-methods-batch-6/tts/vier_tts.py: pronunciation rules, one sentence at a time with
a short pause, silence trimming and short fades. The same model and voices are used.
"""
import json
import os
import re
import sys
import traceback

os.environ.setdefault('PYTHONWARNINGS', 'ignore')
os.environ.setdefault('HF_HUB_OFFLINE', '1')
# Model cache: the same place batch 6 uses (%LOCALAPPDATA%ier-tts\hf-cache), unless HF_HOME is already set.
if 'HF_HOME' not in os.environ:
    _local = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    os.environ['HF_HOME'] = os.path.join(_local, 'vier-tts', 'hf-cache')

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, 'config.json'), encoding='utf-8') as f:
    CFG = json.load(f)
with open(os.path.join(HERE, 'pronunciations.json'), encoding='utf-8') as f:
    RULES = json.load(f)['rules']
SR = CFG['sample_rate']
VOICE_IDS = {v['id'] for v in CFG['voices']}
_pipes = {}


def prep_text(text):
    """Script text -> text the engine receives (pronunciation rules, applied in order)."""
    for pattern, replacement in RULES:
        text = re.sub(pattern, replacement, text)
    return text


def sentences(text):
    return [p for p in re.split(r'(?<=[.!?])\s+', text.strip()) if p]


def lang_code(voice):
    # Kokoro: the first letter of the voice id is the language ('a' American English, 'b' British English).
    return voice[0]


def pipeline(code):
    if code not in _pipes:
        from kokoro import KPipeline

        _pipes[code] = KPipeline(lang_code=code, repo_id=CFG['repo_id'])
    return _pipes[code]


def synth(text, voice, speed):
    pipe = pipeline(lang_code(voice))
    gap = np.zeros(int(CFG['sentence_gap_s'] * SR), dtype=np.float32)
    out = []
    for i, sent in enumerate(sentences(prep_text(text))):
        chunks = []
        for _, _, audio in pipe(sent, voice=voice, speed=speed):
            chunks.append(audio.numpy() if hasattr(audio, 'numpy') else np.asarray(audio))
        if not chunks:
            raise RuntimeError('The engine produced no audio for: ' + sent)
        if i:
            out.append(gap)
        out.append(np.concatenate(chunks).astype(np.float32))
    if not out:
        raise RuntimeError('The text is empty.')
    return np.concatenate(out)


def trim(a):
    """Remove leading and trailing silence, keeping a small pad so no word is clipped."""
    threshold = 10 ** (CFG['trim_threshold_db'] / 20)
    idx = np.where(np.abs(a) > threshold)[0]
    if len(idx) == 0:
        return a
    pad = int(CFG['edge_pad_s'] * SR)
    return a[max(0, idx[0] - pad): min(len(a), idx[-1] + pad + 1)]


def fade(a):
    n = max(1, int(CFG['fade_ms'] / 1000 * SR))
    a = a.copy()
    ramp = np.linspace(0, 1, n, dtype=np.float32)
    a[:n] *= ramp
    a[-n:] *= ramp[::-1]
    return a


def handle(req):
    op = req.get('op')
    if op == 'ping':
        return {'python': sys.version.split()[0], 'engine': CFG['engine']}
    if op == 'voices':
        return {'voices': CFG['voices'], 'defaultVoice': CFG['default_voice']}
    if op == 'synth':
        text = str(req.get('text', '')).strip()
        voice = str(req.get('voice', ''))
        speed = float(req.get('speed', CFG['default_speed']))
        out = str(req.get('out', ''))
        if voice not in VOICE_IDS:
            raise ValueError(f'Unknown voice "{voice}".')
        if not (CFG['speed_min'] <= speed <= CFG['speed_max']):
            raise ValueError(f'Speed must be between {CFG["speed_min"]} and {CFG["speed_max"]}.')
        if not text:
            raise ValueError('The text is empty.')
        if not out:
            raise ValueError('No output file was given.')
        audio = fade(trim(synth(text, voice, speed)))
        os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
        sf.write(out, audio, SR, subtype='PCM_16')
        return {'file': out, 'durationSec': round(len(audio) / SR, 3)}
    raise ValueError(f'Unknown operation "{op}".')


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get('id')
            if req.get('op') == 'shutdown':
                break
            reply = {'id': rid, 'ok': True}
            reply.update(handle(req))
        except Exception as exc:  # reported to the caller; the worker keeps running
            traceback.print_exc(file=sys.stderr)
            reply = {'id': rid, 'ok': False, 'error': str(exc) or type(exc).__name__}
        sys.stdout.write(json.dumps(reply) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
