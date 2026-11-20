import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

interface Props {
  /** Width of the frame in its own pixels (1080 for 9:16 and 1:1, 1920 for 16:9). Used to show the real size. */
  frameWidth: number;
  children: ReactNode;
}

interface View {
  z: number; // zoom relative to "fit": 1 = the frame fills the window
  tx: number; // pan in screen pixels, from the centre
  ty: number;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 16;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const FIT: View = { z: 1, tx: 0, ty: 0 };

/**
 * A view that can be zoomed and panned, for the preview of a frame.
 *  - Ctrl + wheel, or the pinch gesture of a touchpad: zoom around the pointer.
 *  - Two-finger scroll on a touchpad, or the wheel: pan.
 *  - Middle button, Space + drag, or dragging the grey area around the frame: pan.
 *  - Double-click the grey area, or Fit: back to fit. 100%: the frame at its real pixel size.
 * The frame keeps its own mouse handling (layers are still selected and moved): its screen rectangle is what
 * the handlers read, and that rectangle includes the zoom.
 */
export function ZoomStage({ frameWidth, children }: Props) {
  const [view, setView] = useState<View>(FIT);
  const [panning, setPanning] = useState(false);
  const [actual, setActual] = useState(0); // the frame's size as a percentage of its real pixels
  const viewRef = useRef<View>(FIT);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const spaceRef = useRef(false);

  const apply = (next: View) => {
    viewRef.current = next;
    setView(next);
  };

  // Wheel and pinch: the listener must not be passive, or the page would scroll or zoom as well.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = viewRef.current;
      const unit = e.deltaMode === 1 ? 16 : 1; // line-based wheels report lines, not pixels
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (e.ctrlKey) {
        const z = clamp(cur.z * Math.exp(-dy * 0.004), MIN_ZOOM, MAX_ZOOM);
        const r = el.getBoundingClientRect();
        const mx = e.clientX - (r.left + r.width / 2);
        const my = e.clientY - (r.top + r.height / 2);
        const k = z / cur.z;
        apply({ z, tx: mx - k * (mx - cur.tx), ty: my - k * (my - cur.ty) });
      } else {
        apply({ z: cur.z, tx: cur.tx - dx, ty: cur.ty - dy });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Space is the pan key while it is held (not while typing in a field).
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(t.tagName);
    const down = (e: KeyboardEvent) => {
      if (e.key === ' ' && !isField(e.target)) spaceRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // The frame's size on screen, as a percentage of its real pixels.
  useEffect(() => {
    const frame = innerRef.current?.querySelector('.frame') as HTMLElement | null;
    if (frame) setActual(Math.round((frame.getBoundingClientRect().width / frameWidth) * 100));
  }, [view, frameWidth]);

  const onPointerDownCapture = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('.zoom-tools')) return; // the toolbar is not a pan area
    const onFrame = target.closest('.frame') !== null;
    const pan = e.button === 1 || (e.button === 0 && (spaceRef.current || !onFrame));
    if (!pan) return;
    e.preventDefault();
    e.stopPropagation(); // the frame must not start a layer drag
    const start = { x: e.clientX, y: e.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty };
    setPanning(true);
    const move = (ev: PointerEvent) => apply({ ...viewRef.current, tx: start.tx + ev.clientX - start.x, ty: start.ty + ev.clientY - start.y });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setPanning(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Zoom by a factor around the centre of the stage. */
  const zoomBy = (factor: number) => {
    const cur = viewRef.current;
    const z = clamp(cur.z * factor, MIN_ZOOM, MAX_ZOOM);
    const k = z / cur.z;
    apply({ z, tx: cur.tx * k, ty: cur.ty * k });
  };

  /** The frame at its real pixel size: one screen pixel per frame pixel. */
  const showActual = () => {
    const frame = innerRef.current?.querySelector('.frame') as HTMLElement | null;
    if (!frame) return;
    // Zoom by the factor that makes the frame's screen width equal its pixel width.
    zoomBy(frameWidth / frame.getBoundingClientRect().width);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.frame')) apply(FIT);
  };

  return (
    <div
      ref={stageRef}
      className="zoom-stage"
      data-testid="zoom-stage"
      data-zoom={view.z.toFixed(3)}
      data-pan-x={Math.round(view.tx)}
      data-pan-y={Math.round(view.ty)}
      data-panning={panning ? 'true' : 'false'}
      onPointerDownCapture={onPointerDownCapture}
      onDoubleClick={onDoubleClick}
    >
      <div ref={innerRef} className="zoom-inner" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.z})` }}>
        {children}
      </div>
      <div className="zoom-tools" role="toolbar" aria-label="Zoom the preview">
        <button className="btn icon ghost" aria-label="Zoom out" title="Zoom out (Ctrl + wheel)" data-testid="zoom-out" onClick={() => zoomBy(1 / 1.25)}>
          −
        </button>
        <button className="btn ghost" data-testid="zoom-fit" title="Fit the frame in the window (double-click the grey area too)" onClick={() => apply(FIT)}>
          Fit
        </button>
        <span className="zoom-label" data-testid="zoom-label">
          {actual}%
        </span>
        <button className="btn icon ghost" aria-label="Zoom in" title="Zoom in (Ctrl + wheel)" data-testid="zoom-in" onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button className="btn ghost" data-testid="zoom-actual" title="The frame at its real pixel size" onClick={showActual}>
          100%
        </button>
      </div>
    </div>
  );
}
