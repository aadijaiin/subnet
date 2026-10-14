/** Strip a requested nickname down to something safe and readable. */
export function sanitizeNick(raw: string): string {
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_.\-]/gu, '')
    .slice(0, 20);
  return cleaned || 'anon';
}

/**
 * Collision-free nickname assignment: "alice" → "alice-2" → "alice-3"…
 * Comparison is case-insensitive so "Alice" and "alice" can't coexist.
 */
export function uniqueNick(wanted: string, taken: Iterable<string>): string {
  const base = sanitizeNick(wanted);
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 17)}-${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
