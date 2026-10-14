import type { ChatMessage, FileOffer, Member, RoomState } from '../protocol/types.js';
import type { DiscoveredRoom } from '../transport/types.js';

/**
 * Single source of truth for everything the UI shows.
 *
 * The engine writes, the UI reads. State is replaced immutably on every
 * update, so React can bail out on reference equality, and listeners are
 * notified at most once per frame (~30 fps) regardless of how chatty the
 * network is. The store knows nothing about sockets or React.
 */

export type ConnStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface UIMessage extends ChatMessage {
  /** Sent by us, not yet acknowledged by the hub (sits in the outbox). */
  pending?: boolean;
  /** Client-side notice that never went over the wire. */
  local?: boolean;
  level?: 'info' | 'warn' | 'error';
}

export interface ActiveRoom {
  state: RoomState;
  members: Member[];
  successors: string[];
  messages: UIMessage[];
  hosting: boolean;
  status: ConnStatus;
  rttMs: number | null;
  hostAddr: string;
}

export type TransferState =
  | 'hashing'
  | 'offered' //   incoming, waiting for /accept
  | 'waiting' //   outgoing, offer sent, nobody fetched yet
  | 'active'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'rejected'
  | 'cancelled';

export interface Transfer {
  id: string; // xfer id (down), xfer id (up/hashing), `${xfer}>${node}` (per-recipient upload)
  xfer: string;
  direction: 'up' | 'down';
  name: string;
  size: number;
  bytes: number;
  peer: string; // nickname, or "room"
  peerNode?: string;
  state: TransferState;
  speed: number; // bytes/s, smoothed
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  path?: string; // final path (download) or source path (upload)
  offer?: FileOffer;
  resumedFrom?: number;
}

export interface SelfInfo {
  node: string;
  nick: string;
  ip: string;
  ctrlPort: number;
  filePort: number;
  transport: string;
  downloadDir: string;
}

export interface AppState {
  self: SelfInfo;
  lanNodes: number;
  rooms: DiscoveredRoom[];
  room: ActiveRoom | null;
  /** Feed shown when not in a room: help, notices, errors. */
  lobby: UIMessage[];
  transfers: Transfer[];
}

const MAX_MESSAGES = 1000;
const MAX_TRANSFERS = 50;

export class Store {
  private state: AppState;
  private listeners = new Set<() => void>();
  private scheduled: NodeJS.Timeout | null = null;
  private lastNotify = 0;
  private noticeSeq = 0;

  constructor(
    self: SelfInfo,
    private readonly frameMs = 33,
  ) {
    this.state = { self, lanNodes: 0, rooms: [], room: null, lobby: [], transfers: [] };
  }

  get = (): AppState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Apply an immutable update. */
  update(fn: (s: AppState) => AppState): void {
    const next = fn(this.state);
    if (next === this.state) return;
    this.state = next;
    this.schedule();
  }

  // ── convenience mutators ──

  setSelf(patch: Partial<SelfInfo>): void {
    this.update((s) => ({ ...s, self: { ...s.self, ...patch } }));
  }

  setRoom(fn: (r: ActiveRoom) => ActiveRoom): void {
    this.update((s) => (s.room ? { ...s, room: fn(s.room) } : s));
  }

  /** Insert or replace (by id) a message in the active room, keeping ts order. */
  upsertMessage(m: UIMessage): void {
    this.setRoom((r) => ({ ...r, messages: upsert(r.messages, m) }));
  }

  /** Merge a batch (e.g. history replay after reconnect), deduping by id. */
  mergeMessages(batch: UIMessage[]): void {
    this.setRoom((r) => {
      let msgs = r.messages;
      for (const m of batch) msgs = upsert(msgs, m);
      return { ...r, messages: msgs };
    });
  }

  /** A local notice: goes to the room feed if in a room, else the lobby. */
  notice(text: string, level: UIMessage['level'] = 'info'): void {
    const m: UIMessage = {
      id: `local-${++this.noticeSeq}`,
      from: 'local',
      nick: '',
      kind: 'system',
      text,
      ts: Date.now(),
      local: true,
      level,
    };
    this.update((s) =>
      s.room ? { ...s, room: { ...s.room, messages: cap([...s.room.messages, m]) } } : { ...s, lobby: cap([...s.lobby, m]) },
    );
  }

  clearFeed(): void {
    this.update((s) => (s.room ? { ...s, room: { ...s.room, messages: [] } } : { ...s, lobby: [] }));
  }

  upsertTransfer(t: Transfer): void {
    this.update((s) => {
      const i = s.transfers.findIndex((x) => x.id === t.id);
      const transfers = i === -1 ? [...s.transfers, t].slice(-MAX_TRANSFERS) : s.transfers.with(i, t);
      return { ...s, transfers };
    });
  }

  patchTransfer(id: string, patch: Partial<Transfer>): void {
    this.update((s) => {
      const i = s.transfers.findIndex((x) => x.id === id);
      if (i === -1) return s;
      return { ...s, transfers: s.transfers.with(i, { ...s.transfers[i], ...patch, updatedAt: Date.now() }) };
    });
  }

  getTransfer(id: string): Transfer | undefined {
    return this.state.transfers.find((t) => t.id === id);
  }

  // ── notification throttling ──

  private schedule(): void {
    if (this.scheduled) return;
    const wait = Math.max(0, this.frameMs - (Date.now() - this.lastNotify));
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.lastNotify = Date.now();
      for (const l of this.listeners) l();
    }, wait);
  }
}

function upsert(msgs: UIMessage[], m: UIMessage): UIMessage[] {
  const i = msgs.findLastIndex((x) => x.id === m.id);
  if (i !== -1) return msgs.with(i, m);
  // Common case: newest message → append. Otherwise insert in ts order.
  // Pending (unacked) messages always stay at the bottom.
  const last = msgs[msgs.length - 1];
  if (!last || m.pending || (!last.pending && last.ts <= m.ts)) return cap([...msgs, m]);
  let j = msgs.length;
  while (j > 0 && (msgs[j - 1].pending || msgs[j - 1].ts > m.ts)) j--;
  return cap([...msgs.slice(0, j), m, ...msgs.slice(j)]);
}

function cap<T>(a: T[]): T[] {
  return a.length > MAX_MESSAGES ? a.slice(-MAX_MESSAGES) : a;
}
