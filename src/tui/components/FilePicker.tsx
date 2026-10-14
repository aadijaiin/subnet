import { Box, Text, useInput } from 'ink';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { useEffect, useMemo, useState } from 'react';
import { formatBytes, truncate } from '../../util/format.js';

interface Entry {
  name: string;
  dir: boolean;
  size: number;
}

interface Props {
  width: number;
  height: number;
  target?: string;
  onPick: (path: string) => void;
  onCancel: () => void;
}

/** Keyboard file browser: type to filter, ⏎ open/select, ⌫ up a level, Esc cancel. */
export function FilePicker({ width, height, target, onPick, onCancel }: Props) {
  const [cwd, setCwd] = useState(process.cwd());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dirents = await readdir(cwd, { withFileTypes: true });
        const list = await Promise.all(
          dirents.slice(0, 2000).map(async (d): Promise<Entry | null> => {
            try {
              const st = await stat(join(cwd, d.name));
              return { name: d.name, dir: st.isDirectory(), size: st.size };
            } catch {
              return null;
            }
          }),
        );
        if (cancelled) return;
        setEntries(list.filter((e): e is Entry => !!e).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
        setError('');
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    setFilter('');
    setCursor(0);
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    const list = entries.filter((e) => (showHidden || !e.name.startsWith('.')) && (!f || e.name.toLowerCase().includes(f)));
    return [{ name: '..', dir: true, size: 0 }, ...list];
  }, [entries, filter, showHidden]);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setCursor((c) => Math.min(shown.length - 1, c + 1));
    if (key.pageUp) return setCursor((c) => Math.max(0, c - (height - 5)));
    if (key.pageDown) return setCursor((c) => Math.min(shown.length - 1, c + (height - 5)));
    if (key.return) {
      const e = shown[cursor];
      if (!e) return;
      if (e.name === '..') return setCwd(dirname(cwd));
      if (e.dir) return setCwd(join(cwd, e.name));
      return onPick(join(cwd, e.name));
    }
    if (key.backspace) {
      if (filter) return setFilter((f) => f.slice(0, -1));
      return setCwd(dirname(cwd));
    }
    if (key.ctrl && input === 'h') return setShowHidden((v) => !v);
    if (input === '~' && !filter) return setCwd(homedir());
    if (!key.ctrl && !key.meta && input && !/[\x00-\x1f]/.test(input)) {
      setFilter((f) => f + input);
      setCursor(1);
    }
  });

  const listH = Math.max(1, height - 5);
  const first = Math.max(0, Math.min(cursor - Math.floor(listH / 2), shown.length - listH));
  const inner = width - 4;

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="cyan" paddingX={1} overflow="hidden">
      <Text bold wrap="truncate">
        <Text color="cyan">Send file{target ? ` to ${target}` : ' to room'} </Text>
        <Text dimColor>{truncate(cwd, inner - 20)}</Text>
      </Text>
      <Text wrap="truncate">
        <Text dimColor>filter: </Text>
        {filter || <Text dimColor>type to filter · ~ home · ^H hidden files</Text>}
      </Text>
      <Box flexDirection="column" height={listH}>
        {error ? (
          <Text color="red">{error}</Text>
        ) : (
          shown.slice(first, first + listH).map((e, i) => {
            const idx = first + i;
            const size = e.dir ? '' : formatBytes(e.size);
            return (
              <Text key={e.name} inverse={idx === cursor} wrap="truncate">
                <Text color={e.dir ? 'blueBright' : undefined}>
                  {truncate(e.dir ? `${e.name}/` : e.name, inner - 12).padEnd(inner - 12)}
                </Text>
                <Text dimColor={idx !== cursor}>{size.padStart(10)}</Text>
              </Text>
            );
          })
        )}
      </Box>
      <Text dimColor wrap="truncate">
        ↑↓ move · ⏎ open/send · ⌫ up · Esc cancel · {shown.length - 1} items
      </Text>
    </Box>
  );
}
