import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { AppState } from '../../store/Store.js';
import { formatDuration, nodeColor, truncate } from '../../util/format.js';

interface Props {
  state: AppState;
  width: number;
  height: number;
  focused: boolean;
  cursor: number;
  now: number;
}

/** Room browser (discovered rooms) on top, member list of the current room below. */
export function Sidebar({ state, width, height, focused, cursor, now }: Props) {
  const inner = width - 4;
  const { rooms, room, self } = state;
  const members = [...(room?.members ?? [])].sort((a, b) => Number(!!b.host) - Number(!!a.host));
  // Split the height: rooms get what they need (min 3 rows), members get the rest.
  const roomRows = Math.max(3, Math.min(rooms.length || 1, Math.floor((height - 6) / 2)));
  const memberRows = Math.max(1, height - 2 - 3 - roomRows - 1);
  const firstRoom = Math.max(0, Math.min(cursor - roomRows + 1, rooms.length - roomRows));

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      overflow="hidden"
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={focused ? 'cyan' : undefined}>
          ROOMS
        </Text>
        <Text dimColor>{focused ? '⏎ join' : 'Tab'}</Text>
      </Box>
      <Box flexDirection="column" height={roomRows}>
        {rooms.length === 0 ? (
          <Text dimColor wrap="truncate">
            {truncate(state.self.transport === 'direct' ? 'discovery off — /connect' : 'scanning LAN…', inner)}
          </Text>
        ) : (
          rooms.slice(firstRoom, firstRoom + roomRows).map((r, i) => {
            const idx = firstRoom + i;
            const selected = focused && idx === cursor;
            const current = room?.state.id === r.id;
            const tags = `${r.locked ? '🔒' : ''}${r.exp ? '⏳' : ''}`;
            const count = String(r.members);
            const nameW = Math.max(3, inner - 4 - count.length - stringWidth(tags) - 1);
            return (
              <Text key={r.id} wrap="truncate" inverse={selected} color={current ? 'green' : undefined}>
                {current ? '● ' : `${idx + 1}`.padEnd(2)} {truncate(r.name, nameW).padEnd(nameW)} <Text dimColor={!selected}>{count}</Text>
                {tags ? <Text color="yellow">{tags}</Text> : null}
              </Text>
            );
          })
        )}
      </Box>
      <Text dimColor>{'─'.repeat(inner)}</Text>
      <Box justifyContent="space-between">
        <Text bold>PEERS</Text>
        <Text dimColor>{room ? members.length : ''}</Text>
      </Box>
      <Box flexDirection="column" height={memberRows} overflow="hidden">
        {!room ? (
          <Text dimColor wrap="truncate">
            {truncate('not in a room', inner)}
          </Text>
        ) : (
          members.slice(0, memberRows).map((m) => (
            <Text key={m.node} wrap="truncate">
              <Text color="yellow">{m.host ? '★' : ' '}</Text>{' '}
              <Text color={nodeColor(m.node)} bold={m.node === self.node}>
                {truncate(m.nick, inner - 8)}
              </Text>
              {m.node === self.node ? <Text dimColor> (you)</Text> : null}
            </Text>
          ))
        )}
        {room && members.length > memberRows ? <Text dimColor>+{members.length - memberRows} more</Text> : null}
      </Box>
      {room?.state.exp ? (
        <Text color="yellow" wrap="truncate">
          ⏳ {formatDuration(room.state.exp - now)} left
        </Text>
      ) : null}
    </Box>
  );
}
