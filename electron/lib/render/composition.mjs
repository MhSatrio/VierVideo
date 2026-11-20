// In-page layer renderer for the composition (Stage 4). installComposition() is injected into the render page
// as source text, after the page has loaded, so it must stay self-contained (no imports, no closures).
// Each layer is a DOM element: image (vvasset URL), shape (div or inline SVG) or text. window.__vvComp.render(state)
// sets every element for one frame from the state computed by shared/timeline.mjs (layerStates).
// Layers are drawn above the HTML animation unless `behind` is set, in which case they sit under it.

/** @param {any} g  the page's window
 *  @param {{w: number, h: number, css: string, assetBase: string}} opts */
export function installComposition(g, opts) {
  const doc = g.document;
  if (g.__vvComp) return true;
  const style = doc.createElement('style');
  style.textContent = opts.css;
  (doc.head || doc.documentElement).appendChild(style);

  const makeRoot = (z) => {
    const d = doc.createElement('div');
    d.setAttribute('data-vv-root', String(z));
    d.style.cssText = 'position:fixed;left:0;top:0;width:' + opts.w + 'px;height:' + opts.h + 'px;pointer-events:none;overflow:hidden;z-index:' + z + ';';
    doc.documentElement.appendChild(d);
    return d;
  };
  const above = makeRoot(2147483000);
  const behind = makeRoot(-1);
  const els = new Map();

  const build = (l) => {
    let el;
    if (l.kind === 'image') {
      el = doc.createElement('img');
      el.draggable = false;
      el.style.objectFit = 'contain';
    } else if (l.kind === 'text') {
      el = doc.createElement('div');
      el.style.whiteSpace = 'pre-wrap';
      el.style.overflowWrap = 'anywhere';
      el.style.lineHeight = '1.15';
      el.style.fontFamily = "'Jost', system-ui, sans-serif";
    } else if (l.kind === 'snippet') {
      // An HTML element imported as a layer: its own shadow root keeps its styles to itself.
      el = doc.createElement('div');
      el.style.overflow = 'hidden';
      el.attachShadow({ mode: 'open' });
    } else if (l.shape === 'line' || l.shape === 'arrow') {
      el = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    } else {
      el = doc.createElement('div');
    }
    el._vvKind = l.kind + ':' + (l.shape || '');
    el.style.position = 'absolute';
    el.style.boxSizing = 'border-box';
    el.style.transformOrigin = '50% 50%';
    return el;
  };

  // The element's HTML is written only when it changes (the frame is drawn again at every time).
  const paintSnippet = (el, l) => {
    if (el._vvHtml === l.html) return;
    el._vvHtml = l.html;
    el.shadowRoot.innerHTML = l.html || '';
  };

  const paintShape = (el, l) => {
    if (l.shape === 'line' || l.shape === 'arrow') {
      const w = l.w;
      const h = l.h;
      const sw = Math.max(1, l.strokeWidth || 1);
      let inner = '<line x1="0" y1="' + h / 2 + '" x2="' + (w - (l.shape === 'arrow' ? 18 : 0)) + '" y2="' + h / 2 + '" stroke="' + l.stroke + '" stroke-width="' + sw + '" stroke-linecap="round"/>';
      if (l.shape === 'arrow') {
        inner += '<polygon points="' + (w - 18) + ',' + (h / 2 - 12) + ' ' + w + ',' + h / 2 + ' ' + (w - 18) + ',' + (h / 2 + 12) + '" fill="' + l.stroke + '"/>';
      }
      el.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      el.setAttribute('width', String(w));
      el.setAttribute('height', String(h));
      el.innerHTML = inner;
      return;
    }
    el.style.background = l.fill;
    el.style.border = (l.strokeWidth || 0) + 'px solid ' + l.stroke;
    el.style.borderRadius = l.shape === 'ellipse' ? '50%' : '0';
  };

  const paintText = (el, l) => {
    el.textContent = l.text;
    el.style.fontSize = l.fontSize + 'px';
    el.style.fontWeight = String(l.fontWeight);
    el.style.color = l.color;
    el.style.textAlign = l.align;
  };

  // Elements of the animation moved in the studio. `translate` is the element's own CSS property, so it adds to the
  // motion the animation gives the element. Offsets that are no longer wanted are cleared first.
  const moved = new Set();

  g.__vvComp = {
    render(state) {
      if (doc.body) doc.body.style.visibility = state.base.visible ? '' : 'hidden';
      for (const el of moved) el.style.translate = '';
      moved.clear();
      for (const o of state.offsets || []) {
        let el = null;
        try {
          el = doc.querySelector(o.selector);
        } catch {
          el = null; // not a valid path any more: the offset does nothing
        }
        if (!el) continue;
        // The offset is for the element it was made for: another element at the same path is not moved.
        if (o.tag && (el.tagName.toLowerCase() !== o.tag || (o.id || '') !== (el.id || ''))) continue;
        el.style.translate = `${Number(o.x) || 0}px ${Number(o.y) || 0}px`;
        moved.add(el);
      }
      const wanted = new Set();
      for (const l of state.layers) {
        wanted.add(l.id);
        const kindKey = l.kind + ':' + (l.shape || '');
        let el = els.get(l.id);
        if (!el || el._vvKind !== kindKey) {
          if (el) el.remove();
          el = build(l);
          els.set(l.id, el);
        }
        const root = l.behind ? behind : above;
        if (el.parentNode !== root) root.appendChild(el);
        el.style.display = l.visible ? '' : 'none';
        if (!l.visible) continue;
        el.style.left = l.x + 'px';
        el.style.top = l.y + 'px';
        el.style.width = l.w + 'px';
        el.style.height = l.h + 'px';
        el.style.transform = 'rotate(' + (l.rotation || 0) + 'deg)';
        el.style.opacity = String(l.opacity);
        el.style.zIndex = String(l.z);
        if (l.kind === 'image') {
          const src = opts.assetBase + encodeURIComponent(l.assetId || '');
          if (el.getAttribute('src') !== src) el.setAttribute('src', src);
        } else if (l.kind === 'text') {
          paintText(el, l);
        } else if (l.kind === 'snippet') {
          paintSnippet(el, l);
        } else {
          paintShape(el, l);
        }
      }
      for (const [id, el] of Array.from(els.entries())) {
        if (!wanted.has(id)) {
          el.remove();
          els.delete(id);
        }
      }
      return true;
    },
  };
  return true;
}
