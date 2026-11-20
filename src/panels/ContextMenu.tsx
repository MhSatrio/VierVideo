import { useEffect, useRef, type CSSProperties } from 'react';

export interface MenuItem {
  label: string;
  hint?: string;
  testId: string;
  disabled?: boolean;
  onSelect(): void;
}

interface Props {
  x: number;
  y: number;
  title: string;
  items: MenuItem[];
  onClose(): void;
}

/** A small menu at a point of the window. Closes on a click outside it, or Escape. Stays inside the window. */
export function ContextMenu({ x, y, title, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const style = {
    left: Math.max(8, Math.min(x, window.innerWidth - 260)),
    top: Math.max(8, Math.min(y, window.innerHeight - 120)),
  } as CSSProperties;

  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label={title} data-testid="edit-element-menu" style={style}>
      <div className="ctx-title">{title}</div>
      {items.map((item) => (
        <button
          key={item.testId}
          type="button"
          role="menuitem"
          className="ctx-item"
          data-testid={item.testId}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          <span>{item.label}</span>
          {item.hint && <small>{item.hint}</small>}
        </button>
      ))}
    </div>
  );
}
