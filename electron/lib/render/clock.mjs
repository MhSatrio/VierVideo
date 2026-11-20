// Virtual clock for deterministic rendering.
//
// installClock() is injected into the page as source text before any page script runs, so it must stay
// self-contained: no imports, no references to module-level variables. Inside the page it replaces the
// sources of time (performance.now, Date, requestAnimationFrame, setTimeout/setInterval), makes Math.random
// repeatable, and holds CSS / Web Animations at the requested time. Nothing advances until the host calls
// window.__vvClock.advance(t), so a frame is always the same for the same t.

/** @param {any} g  the page's global object (window) or a test double
 *  @param {{epoch?: number, seed?: number}} opts */
export function installClock(g, opts) {
  const st = { now: 0, id: 1, seq: 0, raf: new Map(), timers: new Map(), registered: 0 };
  const EPOCH = Number(opts && opts.epoch) || 0;
  let seed = (Number(opts && opts.seed) || 1) >>> 0;

  // Seeded PRNG (mulberry32): the same seed gives the same sequence in every render.
  g.Math.random = function random() {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  g.performance.now = function now() {
    return st.now;
  };

  const RealDate = g.Date;
  g.Date = class VirtualDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(EPOCH + st.now);
      else super(...args);
    }
    static now() {
      return EPOCH + st.now;
    }
  };

  g.requestAnimationFrame = function requestAnimationFrame(cb) {
    const id = st.id++;
    st.raf.set(id, cb);
    st.registered++;
    return id;
  };
  g.cancelAnimationFrame = function cancelAnimationFrame(id) {
    st.raf.delete(id);
  };

  function addTimer(cb, delay, args, repeat) {
    if (typeof cb !== 'function') return 0;
    const d = Math.max(repeat ? 1 : 0, Number(delay) || 0);
    const id = st.id++;
    st.timers.set(id, { at: st.now + d, every: repeat ? d : 0, cb, args, seq: st.seq++ });
    return id;
  }
  g.setTimeout = function setTimeout(cb, delay, ...args) {
    return addTimer(cb, delay, args, false);
  };
  g.setInterval = function setInterval(cb, delay, ...args) {
    return addTimer(cb, delay, args, true);
  };
  g.clearTimeout = function clearTimeout(id) {
    st.timers.delete(id);
  };
  g.clearInterval = function clearInterval(id) {
    st.timers.delete(id);
  };

  // The earliest timer that is due at or before t (ties: the one scheduled first).
  function nextDue(t) {
    let bestId = 0;
    let best = null;
    for (const [id, tm] of st.timers) {
      if (tm.at <= t && (best === null || tm.at < best.at || (tm.at === best.at && tm.seq < best.seq))) {
        best = tm;
        bestId = id;
      }
    }
    return best === null ? null : { id: bestId, tm: best };
  }

  /** Moves the page to virtual time t (ms since the start): runs due timers in order, then one animation frame, then sets CSS animations. */
  function advance(t) {
    t = Number(t) || 0;
    for (let d = nextDue(t); d !== null; d = nextDue(t)) {
      st.now = d.tm.at;
      if (d.tm.every) {
        d.tm.at += d.tm.every;
        d.tm.seq = st.seq++;
      } else {
        st.timers.delete(d.id);
      }
      d.tm.cb(...d.tm.args);
    }
    st.now = t;
    const frame = Array.from(st.raf.values());
    st.raf.clear();
    for (const cb of frame) cb(t);

    let media = 0;
    const doc = g.document;
    if (doc) {
      if (typeof doc.getAnimations === 'function') {
        for (const a of doc.getAnimations()) {
          a.pause();
          a.currentTime = t;
        }
      }
      if (typeof doc.querySelectorAll === 'function') media = doc.querySelectorAll('video,audio').length;
    }
    return { now: t, frames: frame.length, timers: st.timers.size, media };
  }

  g.__vvClock = {
    advance,
    now: () => st.now,
    pending: () => st.raf.size,
    registered: () => st.registered,
  };
}

/** Source text to inject before the page's own scripts. */
export function clockSource(opts) {
  return '(' + installClock.toString() + ')(window, ' + JSON.stringify(opts ?? {}) + ');';
}
