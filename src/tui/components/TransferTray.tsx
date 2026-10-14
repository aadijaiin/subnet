import { Box, Text } from 'ink';
import type { Transfer } from '../../store/Store.js';
import { formatBytes, formatDuration, truncate } from '../../util/format.js';

/** How long finished transfers stay visible in the tray. */
export const LINGER_MS = 8000;

export function visibleTransfers(transfers: Transfer[], now: number, max = 4): Transfer[] {
  return transfers
    .filter((t) => !t.finishedAt || now - t.finishedAt < LINGER_MS || t.state === 'offered')
    .filter((t) => t.state !== 'offered' || now - t.startedAt < 10 * 60_000)
    .slice(-max);
}

function Bar({ ratio, width, color }: { ratio: number; width: number; color: string }) {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return (
    <Text>
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(width - filled)}</Text>
    </Text>
  );
}

function Row({ t, width }: { t: Transfer; width: number }) {
  const arrow = t.direction === 'up' ? '↑' : '↓';
  const who = t.direction === 'up' ? `to ${t.peer}` : `from ${t.peer}`;
  const nameW = Math.max(8, Math.min(28, Math.floor(width * 0.28)));
  const name = truncate(t.name, nameW).padEnd(nameW);
  const ratio = t.size ? t.bytes / t.size : 1;

  switch (t.state) {
    case 'offered':
      return (
        <Text wrap="truncate">
          <Text color="blueBright">{arrow}</Text> {name}{' '}
          <Text dimColor>
            {formatBytes(t.size)} {who}{' '}
          </Text>
          <Text color="green">/accept {t.xfer}</Text> <Text dimColor>·</Text> <Text color="red">/reject {t.xfer}</Text>
        </Text>
      );
    case 'hashing':
    case 'active':
    case 'verifying': {
      const barW = Math.max(6, Math.min(30, width - nameW - 50));
      const eta = t.speed > 0 ? formatDuration(((t.size - t.bytes) / t.speed) * 1000) : '—';
      const label =
        t.state === 'hashing' ? 'hashing' : t.state === 'verifying' ? 'verifying sha256' : `${formatBytes(t.speed)}/s  ETA ${eta}`;
      return (
        <Text wrap="truncate">
          <Text color="cyan">{arrow}</Text> {name} <Bar ratio={ratio} width={barW} color={t.state === 'hashing' ? 'magenta' : 'cyan'} />{' '}
          {String(Math.floor(ratio * 100)).padStart(3)}%{' '}
          <Text dimColor>
            {label} {who}
            {t.resumedFrom ? '  (resumed)' : ''}
          </Text>
        </Text>
      );
    }
    case 'waiting':
      return (
        <Text wrap="truncate">
          <Text color="blueBright">{arrow}</Text> {name}{' '}
          <Text dimColor>
            offered {who} · {formatBytes(t.size)} · id {t.xfer}
          </Text>
        </Text>
      );
    case 'done':
      return (
        <Text wrap="truncate">
          <Text color="green">✓</Text> {name}{' '}
          <Text dimColor>{t.direction === 'down' ? `saved → ${t.path}` : `sent ${who}`} · sha256 ok</Text>
        </Text>
      );
    default:
      return (
        <Text wrap="truncate">
          <Text color="red">✗</Text> {name} <Text color="red">{t.state}</Text>
          <Text dimColor>
            {t.error ? ` — ${t.error}` : ''}
            {t.state === 'failed' && t.direction === 'down' ? ` · /accept ${t.xfer} to resume` : ''}
          </Text>
        </Text>
      );
  }
}

export function TransferTray({ transfers, width }: { transfers: Transfer[]; width: number }) {
  if (!transfers.length) return null;
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="blue" paddingX={1}>
      {transfers.map((t) => (
        <Row key={t.id} t={t} width={width - 4} />
      ))}
    </Box>
  );
}
