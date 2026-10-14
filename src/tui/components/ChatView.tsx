import { Box, Text } from 'ink';
import { memo } from 'react';
import type { ActiveRoom } from '../../store/Store.js';
import type { Line } from '../lines.js';

interface Props {
  room: ActiveRoom | null;
  lines: Line[];
  width: number;
  height: number;
  /** Lines scrolled up from the bottom (0 = following live). */
  scroll: number;
  unseen: number;
}

const LineView = memo(function LineView({ line }: { line: Line }) {
  return (
    <Text wrap="truncate">
      {line.segs.map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim} italic={s.italic}>
          {s.t}
        </Text>
      ))}
    </Text>
  );
});

export function ChatView({ room, lines, width, height, scroll, unseen }: Props) {
  const bodyH = Math.max(1, height - 3); // border (2) + header (1)
  const end = Math.max(0, lines.length - scroll);
  const visible = lines.slice(Math.max(0, end - bodyH), end);
  const status = room?.status;

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="gray" paddingX={1} overflow="hidden">
      <Box justifyContent="space-between" height={1}>
        <Text bold wrap="truncate">
          {room ? (
            <>
              <Text color="cyan"># </Text>
              {room.state.name}
              {room.state.locked ? <Text dimColor> · locked</Text> : null}
              {room.hosting ? <Text color="yellow"> · you're hosting</Text> : null}
            </>
          ) : (
            <Text color="cyan">subnet · lobby</Text>
          )}
        </Text>
        {status && status !== 'connected' ? <Text color="yellow">{status}…</Text> : null}
        {scroll > 0 ? (
          <Text color="cyan">
            ↑ {scroll} lines{unseen ? ` · ${unseen} new ↓` : ''}
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" height={bodyH} justifyContent="flex-end">
        {visible.map((l) => (
          <LineView key={l.key} line={l} />
        ))}
      </Box>
    </Box>
  );
}
