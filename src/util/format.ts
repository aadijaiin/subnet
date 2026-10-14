export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "30s", "10m", "2h", "1h30m" → ms. */
export function parseDuration(s: string): number | null {
  const re = /(\d+(?:\.\d+)?)\s*(s|m|h|d)/gi;
  let total = 0;
  let matched = '';
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
    matched += m[0];
  }
  return total > 0 && matched.replace(/\s/g, '') === s.replace(/\s/g, '') ? total : null;
}

// Distinct, readable on dark and light backgrounds.
const PALETTE = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red', 'cyanBright', 'greenBright', 'yellowBright', 'magentaBright'];

/** Deterministic per-node color: the same peer is the same color on every screen. */
export function nodeColor(node: string): string {
  let h = 2166136261;
  for (let i = 0; i < node.length; i++) h = Math.imul(h ^ node.charCodeAt(i), 16777619);
  return PALETTE[(h >>> 0) % PALETTE.length];
}

export function truncate(s: string, n: number): string {
  if (n <= 0) return '';
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}
