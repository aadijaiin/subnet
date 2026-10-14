import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type { UIMessage } from '../store/Store.js';
import { formatBytes, formatClock, nodeColor } from '../util/format.js';

export interface Seg {
  t: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
}

export interface Line {
  key: string;
  segs: Seg[];
}

export interface LineContext {
  selfNode: string;
  nickOf: (node: string) => string | undefined;
}

const TIME_W = 6; // "12:34 "

/**
 * Pre-wrap the feed into terminal lines. Ink can't tell us how tall a
 * wrapped <Text> will be before rendering, so we lay text out ourselves:
 * that gives exact line-based scrolling and a stable bottom-anchored view.
 */
export function buildLines(messages: UIMessage[], width: number, ctx: LineContext): Line[] {
  const out: Line[] = [];
  let lastDay = '';
  for (const m of messages) {
    const day = new Date(m.ts).toDateString();
    if (lastDay && day !== lastDay) out.push({ key: `day-${m.id}`, segs: [{ t: `── ${day} ──`, dim: true }] });
    lastDay = day;
    out.push(...messageLines(m, width, ctx));
  }
  return out;
}

function messageLines(m: UIMessage, width: number, ctx: LineContext): Line[] {
  const time: Seg = { t: `${formatClock(m.ts)} `, dim: true };
  const mine = m.from === ctx.selfNode;
  const nickColor = nodeColor(m.from);
  const pendingTag: Seg[] = m.pending ? [{ t: ' (sending…)', dim: true, italic: true }] : [];

  switch (m.kind) {
    case 'system': {
      const color = m.level === 'error' ? 'red' : m.level === 'warn' ? 'yellow' : undefined;
      return wrapped(m.id, [time, { t: '── ', dim: true }], m.text ?? '', width, { color, dim: !color, italic: true });
    }
    case 'me':
      return wrapped(
        m.id,
        [time, { t: '* ', color: nickColor }, { t: m.nick, color: nickColor, bold: true }, { t: ' ' }],
        m.text ?? '',
        width,
        { italic: true },
        pendingTag,
      );
    case 'dm': {
      const label = mine ? `→ ${ctx.nickOf(m.to ?? '') ?? 'them'}` : '→ you';
      return wrapped(
        m.id,
        [
          time,
          { t: '[dm] ', color: 'magenta', bold: true },
          { t: m.nick, color: nickColor, bold: true },
          { t: ` ${label} `, color: 'magenta' },
          { t: '│ ', dim: true },
        ],
        m.text ?? '',
        width,
        { color: 'magentaBright' },
        pendingTag,
      );
    }
    case 'file': {
      const f = m.file;
      const head: Seg[] = [time, { t: m.nick, color: nickColor, bold: true }, { t: ' │ ', dim: true }];
      if (!f) return [];
      const target = m.to ? (mine ? ` to ${ctx.nickOf(m.to) ?? '?'}` : ' to you') : '';
      const lines = wrapped(m.id, head, '', width, {}, [
        { t: '[file] ', color: 'blueBright', bold: true },
        { t: f.name, bold: true },
        { t: ` ${formatBytes(f.size)}${target}`, dim: true },
        ...pendingTag,
      ]);
      if (!mine) {
        lines.push({
          key: `${m.id}-act`,
          segs: [
            { t: ' '.repeat(TIME_W + 2) },
            { t: `/accept ${f.xfer}`, color: 'green' },
            { t: '  ·  ', dim: true },
            { t: `/reject ${f.xfer}`, color: 'red' },
            { t: `   sha256 ${f.sha256.slice(0, 12)}…`, dim: true },
          ],
        });
      }
      return lines;
    }
    default:
      return wrapped(
        m.id,
        [time, { t: m.nick, color: nickColor, bold: true }, { t: ' │ ', dim: true }],
        m.text ?? '',
        width,
        {},
        pendingTag,
      );
  }
}

/** Lay out `prefix` + wrapped body with a hanging indent. */
function wrapped(id: string, prefix: Seg[], body: string, width: number, style: Omit<Seg, 't'>, tail: Seg[] = []): Line[] {
  const prefixW = prefix.reduce((n, s) => n + stringWidth(s.t), 0);
  // Very long nicks on narrow terminals: put the prefix on its own line.
  const hang = prefixW > width / 2;
  const indent = hang ? TIME_W : prefixW;
  const bodyW = Math.max(8, width - indent);

  const rows: string[] = [];
  for (const p of body.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n')) {
    // Keep a paragraph's own indentation (code pastes), but don't let wrap
    // points leave a stray leading space on continuation lines.
    const clean = stripControl(p);
    const lead = clean.match(/^ */)![0].slice(0, Math.floor(bodyW / 2));
    const wrappedRows = wrapAnsi(clean.trimStart(), bodyW - lead.length, { hard: true, trim: true, wordWrap: true }).split('\n');
    rows.push(...wrappedRows.map((r) => lead + r));
  }

  const pad: Seg = { t: ' '.repeat(indent) };
  const out: Line[] = hang ? [{ key: `${id}-h`, segs: [...prefix] }] : [];
  rows.forEach((r, i) => {
    const lead = !hang && i === 0 ? prefix : [pad];
    out.push({ key: `${id}-${i}`, segs: [...lead, { ...style, t: r }] });
  });
  out[out.length - 1].segs.push(...tail);
  return out;
}

/** Remote text must never be able to move the cursor or recolor the terminal. */
export function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
