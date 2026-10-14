import type { Duplex } from 'node:stream';
import type { RoomInfo } from '../protocol/types.js';

/**
 * The seam between the engine and the network.
 *
 * The engine only ever asks a TransportAdapter to (a) accept inbound streams,
 * (b) open outbound streams to "host:port", and (c) optionally discover rooms.
 * Everything above this interface (rooms, handover, file transfer) is
 * transport-agnostic. To run over Tailscale/WireGuard, a relay, or a
 * Cloudflare tunnel, implement this interface and return any Duplex stream.
 * See docs/ARCHITECTURE.md § "Writing a transport adapter".
 */
export interface TransportAdapter {
  readonly name: string;
  /** Start listening; `port` 0 picks a free port. */
  listen(port: number, onStream: (stream: Stream) => void): Promise<Listener>;
  /** Open a reliable, ordered byte stream to a peer. */
  dial(host: string, port: number, timeoutMs?: number): Promise<Stream>;
  /** Best address for peers to reach this node at (used in member rosters). */
  localAddress(): string;
  /** Room discovery, or null when the transport cannot discover (rooms are joined by address). */
  readonly discovery: Discovery | null;
}

export type Stream = Duplex & {
  remoteAddress?: string;
  setNoDelay?: (noDelay?: boolean) => unknown;
};

export interface Listener {
  readonly port: number;
  close(): Promise<void>;
}

export interface DiscoveredRoom extends RoomInfo {
  /** Address to dial, from the beacon's source IP. */
  address: string;
  /** Node id of the announcing host. */
  node: string;
  lastSeen: number;
}

export interface DiscoverySnapshot {
  rooms: DiscoveredRoom[];
  /** Number of distinct live nodes seen on the network (including rooms-less ones). */
  nodes: number;
}

export interface Discovery {
  start(self: { node: string; nick: string }): Promise<void>;
  /** Replace the set of rooms this node advertises; announces immediately. */
  setRooms(rooms: RoomInfo[]): void;
  setNick(nick: string): void;
  /** Ask every host on the network to announce now. */
  query(): void;
  onUpdate(listener: (snap: DiscoverySnapshot) => void): () => void;
  stop(): Promise<void>;
}
