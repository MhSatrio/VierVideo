// Display helpers. Pure functions so they can be unit tested.

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** m:ss for timeline ruler labels; m:ss.s when a fraction is present. */
export function formatTimecode(seconds: number, withTenths = false): string {
  const s = Math.max(0, seconds);
  if (withTenths) {
    // Work in whole tenths: floating-point remainders would otherwise show 12.7 s as 12.6.
    const tenths = Math.round(s * 10);
    const m = Math.floor(tenths / 600);
    const whole = Math.floor((tenths % 600) / 10);
    return `${m}:${String(whole).padStart(2, '0')}.${tenths % 10}`;
  }
  const whole = Math.floor(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatTimeOnly(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Ruler tick step (seconds) so that ticks are at least `minPx` apart. */
export function rulerStep(pxPerSecond: number, minPx = 70): number {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((s) => s * pxPerSecond >= minPx) ?? steps[steps.length - 1];
}

export function assetUrl(id: string): string {
  return `vvasset://asset/${encodeURIComponent(id)}`;
}

/** URL of a file inside the open project (audio/ or renders/ only), served by the vvproj:// scheme. */
export function projectFileUrl(rel: string): string {
  return 'vvproj://file/' + rel.split('/').map(encodeURIComponent).join('/');
}

export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}
