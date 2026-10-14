import { Text, useInput, usePaste } from 'ink';
import { useReducer, useRef } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  isActive: boolean;
  width: number;
  mask?: boolean;
  placeholder?: string;
  onHistory?: (dir: -1 | 1) => void;
}

const WORD_LEFT = /\S+\s*$|\s+$/;
const WORD_RIGHT = /^\s*\S+/;

/**
 * Single-line editor with readline-style keys, horizontal scrolling, input
 * history hooks and bracketed paste (multi-line pastes are kept intact and
 * shown as ⏎, so code snippets survive).
 */
export function TextInput({ value, onChange, onSubmit, isActive, width, mask, placeholder, onHistory }: Props) {
  // The source of truth while typing lives in refs, not render-scoped state:
  // several keystrokes can arrive before React re-renders, and each must see
  // the result of the previous one or characters get lost.
  const val = useRef(value);
  const cur = useRef(value.length);
  const lastProp = useRef(value);
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  if (value !== lastProp.current) {
    lastProp.current = value;
    // An external change (history recall, cleared after submit) moves the cursor to the end.
    if (value !== val.current) {
      val.current = value;
      cur.current = value.length;
    }
  }

  const edit = (next: string, nextCursor: number) => {
    val.current = next;
    cur.current = Math.max(0, Math.min(next.length, nextCursor));
    onChange(next);
    rerender();
  };
  const move = (nextCursor: number) => {
    cur.current = Math.max(0, Math.min(val.current.length, nextCursor));
    rerender();
  };
  const insert = (text: string) => {
    const v = val.current;
    const c = cur.current;
    edit(v.slice(0, c) + text + v.slice(c), c + text.length);
  };

  usePaste((text) => insert(text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')), { isActive });

  useInput(
    (input, key) => {
      const v = val.current;
      const c = cur.current;
      if (key.return) return onSubmit(v);
      if (key.tab || key.escape || key.pageUp || key.pageDown) return;
      // Shift+↑/↓ scrolls the feed (handled by App); plain ↑/↓ walks history.
      if (key.upArrow) return key.shift ? undefined : onHistory?.(-1);
      if (key.downArrow) return key.shift ? undefined : onHistory?.(1);

      if (key.leftArrow) return move(key.meta || key.ctrl ? c - (v.slice(0, c).match(WORD_LEFT)?.[0].length ?? c) : c - 1);
      if (key.rightArrow) return move(key.meta || key.ctrl ? c + (v.slice(c).match(WORD_RIGHT)?.[0].length ?? 0) : c + 1);
      if (key.home || (key.ctrl && input === 'a')) return move(0);
      if (key.end || (key.ctrl && input === 'e')) return move(v.length);

      if (key.backspace || (key.ctrl && input === 'h')) {
        if (c === 0) return;
        const n = key.meta ? (v.slice(0, c).match(WORD_LEFT)?.[0].length ?? 1) : 1;
        return edit(v.slice(0, c - n) + v.slice(c), c - n);
      }
      if (key.ctrl && input === 'w') {
        const n = v.slice(0, c).match(WORD_LEFT)?.[0].length ?? 0;
        return edit(v.slice(0, c - n) + v.slice(c), c - n);
      }
      if (key.delete || (key.ctrl && input === 'd')) return edit(v.slice(0, c) + v.slice(c + 1), c);
      if (key.ctrl && input === 'u') return edit(v.slice(c), 0);
      if (key.ctrl && input === 'k') return edit(v.slice(0, c), c);
      if (key.ctrl || key.meta) return;

      // A fast typist (or a terminal without bracketed paste) can deliver
      // "text⏎" in one chunk; treat the newline as Enter, not as a character.
      const nl = input.search(/[\r\n]/);
      const typed = (nl === -1 ? input : input.slice(0, nl)).replace(/[\x00-\x1f\x7f]/g, '');
      if (typed) insert(typed);
      if (nl !== -1) onSubmit(val.current);
    },
    { isActive },
  );

  const c = Math.min(cur.current, val.current.length);
  value = val.current;
  const shown = (mask ? '•'.repeat(value.length) : value).replace(/\n/g, '⏎');
  if (!shown && placeholder) {
    return (
      <Text>
        {isActive ? <Text inverse> </Text> : null}
        <Text dimColor>{placeholder.slice(0, Math.max(0, width - 1))}</Text>
      </Text>
    );
  }

  // Horizontal scroll: keep the cursor inside the visible window.
  const room = Math.max(1, width - 1);
  const start = Math.max(0, Math.min(c - Math.floor(room * 0.8), shown.length - room + 1));
  const visible = shown.slice(Math.max(0, start), Math.max(0, start) + room);
  const rel = c - Math.max(0, start);
  return (
    <Text>
      {start > 0 ? <Text dimColor>…</Text> : null}
      {visible.slice(start > 0 ? 1 : 0, rel)}
      {isActive ? <Text inverse>{visible[rel] ?? ' '}</Text> : (visible[rel] ?? '')}
      {visible.slice(rel + 1)}
    </Text>
  );
}
