/**
 * Wire protocol: every byte that crosses the network is described here.
 *
 *   1. Discovery   — UDP JSON datagrams (broadcast + multicast) on DISCOVERY_PORT
 *   2. Control     — TCP, frames of [u32 BE length][UTF-8 JSON Envelope]
 *   3. File stream — TCP, a JSON "get"/"meta" handshake using the same framing,
 *                    then [u32 BE length][raw bytes] chunks, terminated by length 0
 *
 * This module has no runtime dependencies on the rest of the app, so a relay
 * server or a client in another language can be written against it alone.
 */

export const PROTOCOL_VERSION = 1;
export const MAGIC = 'SUBNET';

export const DISCOVERY_PORT = 47820;
export const MULTICAST_GROUP = '239.255.71.71';

/** Upper bound on one control frame; protects against garbage input. */
export const MAX_FRAME = 1 << 20;
/** Upper bound on one chat message body. */
export const MAX_TEXT = 64 * 1024;
/** Payload size of one file chunk. */
export const CHUNK_SIZE = 64 * 1024;

// ─── Discovery ──────────────────────────────────────────────────────────────

export type BeaconKind =
  | 'announce' // periodic: "I exist, and these are the rooms I host"
  | 'query' //    "anyone hosting a room, announce right now"
  | 'bye'; //     graceful shutdown: forget my rooms immediately

export interface Beacon {
  m: typeof MAGIC;
  v: number;
  k: BeaconKind;
  node: string;
  nick: string;
  rooms?: RoomInfo[];
  ts: number;
}

/**
 * Public description of a room. The host IP is deliberately absent: receivers
 * pair the datagram's source address with `port`, which is NAT/multi-homing safe.
 */
export interface RoomInfo {
  id: string;
  name: string;
  locked: boolean;
  members: number;
  port: number;
  host: string; // host nickname
  created: number;
  exp?: number; // unix ms; undefined = permanent
}

// ─── Control channel ────────────────────────────────────────────────────────

export interface Envelope<T extends string = string, D = unknown> {
  t: T;
  d?: D;
}

/** hub → client, always the first frame on a new connection. */
export interface Challenge {
  v: number;
  room: string;
  nonce: string;
  locked: boolean;
}

/** client → hub. */
export interface Hello {
  v: number;
  node: string;
  nick: string;
  proof?: string; // HMAC-SHA256(passcode, nonce); the passcode never crosses the wire
  ctrlPort: number; // where this node would host on handover
  filePort: number; // where this node serves file chunks
}

/** hub → client after a successful hello. */
export interface Welcome {
  you: Member;
  room: RoomState;
  members: Member[];
  successors: string[];
  history: ChatMessage[];
}

export interface Reject {
  reason: string;
  code: 'version' | 'passcode' | 'room' | 'full' | 'protocol';
}

/** Everything a successor needs to keep a room alive after handover. */
export interface RoomState {
  id: string;
  name: string;
  locked: boolean;
  created: number;
  exp?: number;
  hostNode: string;
}

export interface Member {
  node: string;
  nick: string;
  ip: string;
  ctrlPort: number;
  filePort: number;
  joined: number;
  host?: boolean;
}

export type MessageKind = 'chat' | 'me' | 'dm' | 'file' | 'system';

export interface ChatMessage {
  id: string; // `${node}-${seq}`, globally unique; the hub dedupes on it
  from: string; // node id ("hub" for system messages)
  nick: string;
  to?: string; // node id: DMs and direct file offers
  kind: MessageKind;
  text?: string;
  file?: FileOffer;
  ts: number; // unix ms, stamped by the hub for a single total order
}

export interface FileOffer {
  xfer: string;
  name: string;
  size: number;
  sha256: string;
  token: string; // capability required to fetch from the sender
}

export interface MembersUpdate {
  members: Member[];
  successors: string[];
}

export interface RoomClosed {
  reason: string;
  handover?: Member; // undefined = the room is gone for good
}

export interface ControlFrames {
  challenge: Challenge;
  hello: Hello;
  welcome: Welcome;
  reject: Reject;
  msg: ChatMessage;
  members: MembersUpdate;
  nick: { nick: string };
  ping: { ts: number };
  pong: { ts: number };
  leave: Record<string, never>;
  room_closed: RoomClosed;
}

export type ControlType = keyof ControlFrames;

// ─── File channel ───────────────────────────────────────────────────────────

export interface Get {
  xfer: string;
  token: string;
  node: string;
  offset: number; // resume point; receiver hashes its partial file locally
}

export interface Meta {
  size: number;
  sha256: string;
  offset: number;
}

export interface FileFrames {
  get: Get;
  meta: Meta;
  err: { reason: string };
}
