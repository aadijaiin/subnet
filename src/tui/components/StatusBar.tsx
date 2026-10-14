import { Box, Text } from 'ink';
import type { AppState } from '../../store/Store.js';

const HEALTH = {
  connected: { dot: '●', color: 'green' },
  connecting: { dot: '◌', color: 'yellow' },
  reconnecting: { dot: '◌', color: 'yellow' },
  closed: { dot: '○', color: 'red' },
} as const;

export function StatusBar({ state, width, hint }: { state: AppState; width: number; hint: string }) {
  const { room, self } = state;
  const h = room ? HEALTH[room.status] : { dot: '○', color: 'gray' };
  const rtt = room?.rttMs != null ? `${room.rttMs}ms` : '';
  const host = room?.members.find((m) => m.host);
  return (
    <Box width={width}>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate">
          <Text color={h.color}>{h.dot}</Text> <Text>{room ? room.status : 'lobby'}</Text>
          {rtt ? <Text dimColor> {rtt}</Text> : null}
          {host ? <Text dimColor> · host {host.node === self.node ? 'you' : host.nick}</Text> : null}
          <Text dimColor> │ </Text>
          <Text bold>{self.nick}</Text>
          <Text dimColor>
            @{self.ip}:{self.ctrlPort} │ {self.transport}
            {self.transport === 'lan' ? ` · ${state.lanNodes} node${state.lanNodes === 1 ? '' : 's'}` : ''}
          </Text>
        </Text>
      </Box>
      {width - hint.length > 60 ? (
        <Box flexShrink={0} marginLeft={2}>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
