import { randomId, verifyProof } from '../protocol/crypto.js';
import { ControlConnection, isLoopback } from '../protocol/framing.js';
import {
  MAX_TEXT,
  PROTOCOL_VERSION,
  type ChatMessage,
  type ControlFrames,
  type ControlType,
  type Hello,
  type Member,
  type RoomInfo,
  type RoomState,
} from '../protocol/types.js';
import type { Stream } from '../transport/types.js';
import { uniqueNick } from './nick.js';

interface Peer {
  conn: ControlConnection;
  member: Member;
  graceful: boolean;
}

export interface HubOptions {
  room: RoomState;
  passcode: string;
  /** Messages to seed history with (used when taking over after handover). */
  history?: ChatMessage[];
  /** This node's reachable address, substituted for loopback peers. */
  localAddress: () => string;
  /** Hosting node's control port, advertised in discovery. */
  port: number;
  historySize?: number;
  maxMembers?: number;
  /** Called whenever the public RoomInfo changes (member count, host nick). */
  onInfo?: (info: RoomInfo) => void;
  /** Called when the room ends (expired, or shut down). */
  onClosed?: (reason: string) => void;
}

/**
 * The hub is the authoritative relay for one room: a star topology where
 * the host's node accepts every member's TCP connection, stamps a total
 * order on messages, and fans them out. The host's own UI joins its hub
 * over loopback like any other client, so there's exactly one client code
 * path — and handover is "another member starts a Hub and everyone dials it".
 *
 * Why a star rather than a full mesh: O(n) connections instead of O(n²),
 * a single message order without vector clocks, and trivial passcode
 * enforcement. File bytes do NOT flow through the hub — they go peer-to-peer.
 */
export class Hub {
  readonly room: RoomState;
  private readonly passcode: string;
  private peers = new Map<string, Peer>();
  private order: string[] = []; // node ids in join order → succession
  private nickMemory = new Map<string, string>(); // node → last nick (reclaimed on reconnect)
  private history: ChatMessage[];
  private seen = new Set<string>();
  private mailbox = new Map<string, ChatMessage[]>(); // offline DM queue
  private expiryTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private sysSeq = 0;

  constructor(private readonly opts: HubOptions) {
    this.room = opts.room;
    this.passcode = opts.passcode;
    this.history = (opts.history ?? []).filter((m) => m.kind !== 'dm' && !(m.kind === 'file' && m.to)).slice(-this.historySize);
    for (const m of this.history) this.seen.add(m.id);
    if (this.room.exp) {
      const ms = this.room.exp - Date.now();
      this.expiryTimer = setTimeout(() => this.shutdown(false, 'room expired'), Math.max(0, ms));
    }
  }

  private get historySize() {
    return this.opts.historySize ?? 200;
  }

  info(): RoomInfo {
    const host = this.peers.get(this.room.hostNode)?.member.nick ?? this.order.map((n) => this.peers.get(n)?.member.nick)[0] ?? '?';
    return {
      id: this.room.id,
      name: this.room.name,
      locked: this.room.locked,
      members: this.peers.size,
      port: this.opts.port,
      host,
      created: this.room.created,
      exp: this.room.exp,
    };
  }

  /** Handle a freshly accepted stream. */
  accept(stream: Stream): void {
    const conn = new ControlConnection(stream);
    if (this.closed) {
      conn.destroy();
      return;
    }
    const nonce = randomId(16);
    conn.send('challenge', { v: PROTOCOL_VERSION, room: this.room.id, nonce, locked: this.room.locked });
    conn
      .next(['hello'], 10_000)
      .then(({ d }) => this.admit(conn, d, nonce))
      .catch(() => conn.destroy());
  }

  private admit(conn: ControlConnection, hello: Hello, nonce: string): void {
    if (this.closed) return conn.destroy();
    const reject = (code: ControlFrames['reject']['code'], reason: string) => {
      conn.send('reject', { code, reason });
      conn.end();
    };
    if (hello?.v !== PROTOCOL_VERSION) return reject('version', `protocol v${hello?.v} unsupported (hub speaks v${PROTOCOL_VERSION})`);
    if (typeof hello.node !== 'string' || !hello.node) return reject('protocol', 'missing node id');
    if (this.room.locked && !verifyProof(this.passcode, nonce, hello.proof)) return reject('passcode', 'wrong passcode');
    const existing = this.peers.get(hello.node);
    if (!existing && this.peers.size >= (this.opts.maxMembers ?? 64)) return reject('full', 'room is full');

    // Reconnect of a known node: silently replace the stale connection, keep its nick.
    let rejoin = false;
    if (existing) {
      existing.graceful = true;
      existing.conn.destroy();
      this.removePeer(hello.node, true);
      rejoin = true;
    }
    const takenNicks = [...this.peers.values()].map((p) => p.member.nick);
    const remembered = this.nickMemory.get(hello.node);
    const nick =
      remembered && !takenNicks.some((n) => n.toLowerCase() === remembered.toLowerCase()) ? remembered : uniqueNick(hello.nick, takenNicks);
    if (remembered) rejoin = true;
    this.nickMemory.set(hello.node, nick);

    const ip = isLoopback(conn.remoteAddress) ? this.opts.localAddress() : conn.remoteAddress;
    const member: Member = {
      node: hello.node,
      nick,
      ip,
      ctrlPort: hello.ctrlPort,
      filePort: hello.filePort,
      joined: Date.now(),
      host: hello.node === this.room.hostNode,
    };
    const peer: Peer = { conn, member, graceful: false };
    this.peers.set(member.node, peer);
    this.order.push(member.node);

    conn.send('welcome', {
      you: member,
      room: this.room,
      members: this.members(),
      successors: this.successors(),
      history: this.history,
    });

    // Offline queue: deliver DMs that arrived while this node was away.
    const queued = this.mailbox.get(member.node);
    if (queued) {
      for (const m of queued) conn.send('msg', m);
      this.mailbox.delete(member.node);
    }

    conn.onFrame((t, d) => this.onFrame(peer, t, d));
    conn.on('close', () => {
      if (this.peers.get(member.node) !== peer) return; // replaced by a reconnect
      this.removePeer(member.node, false);
      if (!this.closed) {
        this.system(peer.graceful ? `${member.nick} left` : `${member.nick} lost connection`);
        this.broadcastRoster();
      }
    });

    const wantedNote = nick.toLowerCase() !== hello.nick.toLowerCase() && !remembered ? ` (as ${nick}; "${hello.nick}" was taken)` : '';
    this.system(rejoin ? `${nick} reconnected` : `${nick} joined${wantedNote}`);
    this.broadcastRoster();
  }

  private onFrame<T extends ControlType>(peer: Peer, t: T, d: ControlFrames[T]): void {
    switch (t) {
      case 'msg':
        return this.onMessage(peer, d as ChatMessage);
      case 'nick': {
        const wanted = (d as { nick: string })?.nick;
        if (typeof wanted !== 'string') return;
        const old = peer.member.nick;
        const others = [...this.peers.values()].filter((p) => p !== peer).map((p) => p.member.nick);
        const nick = uniqueNick(wanted, others);
        if (nick === old) return;
        peer.member = { ...peer.member, nick };
        this.nickMemory.set(peer.member.node, nick);
        this.system(`${old} is now known as ${nick}`);
        this.broadcastRoster();
        return;
      }
      case 'ping':
        peer.conn.send('pong', d as { ts: number });
        return;
      case 'leave':
        peer.graceful = true;
        peer.conn.end();
        return;
    }
  }

  private onMessage(peer: Peer, raw: ChatMessage): void {
    if (!raw || typeof raw.id !== 'string' || !raw.id.startsWith(peer.member.node)) return;
    if (!['chat', 'me', 'dm', 'file'].includes(raw.kind)) return;
    if (raw.text !== undefined && (typeof raw.text !== 'string' || raw.text.length > MAX_TEXT)) return;

    // Authoritative fields come from the hub, never the client.
    const m: ChatMessage = {
      id: raw.id,
      from: peer.member.node,
      nick: peer.member.nick,
      kind: raw.kind,
      ts: Date.now(),
      ...(raw.text !== undefined && { text: raw.text }),
      ...(raw.to && { to: String(raw.to) }),
      ...(raw.kind === 'file' && raw.file && { file: raw.file }),
    };

    // Outbox resend after reconnect: already delivered, just re-ack the sender.
    if (this.seen.has(m.id)) {
      const prior = this.history.find((h) => h.id === m.id) ?? m;
      peer.conn.send('msg', prior);
      return;
    }
    this.seen.add(m.id);
    if (this.seen.size > 10_000) this.seen = new Set([...this.seen].slice(-5000));

    if (m.to) {
      if (m.kind !== 'dm' && m.kind !== 'file') return;
      const target = this.peers.get(m.to);
      peer.conn.send('msg', m); // ack
      if (target) target.conn.send('msg', m);
      else if (this.nickMemory.has(m.to)) {
        const box = this.mailbox.get(m.to) ?? [];
        box.push(m);
        this.mailbox.set(m.to, box.slice(-100));
        this.systemTo(peer, `${this.nickMemory.get(m.to)} is offline — message queued for delivery when they return`);
      }
      return;
    }
    if (m.kind === 'dm') return; // a DM without a target is malformed
    this.pushHistory(m);
    this.broadcast('msg', m);
  }

  /** Graceful stop. With `handover`, members are told who hosts next. */
  shutdown(handover: boolean, reason = 'host left'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const successorNode = handover ? this.successors()[0] : undefined;
    const successor = successorNode ? this.peers.get(successorNode)?.member : undefined;
    for (const p of this.peers.values()) {
      p.conn.send('room_closed', successor ? { reason, handover: successor } : { reason });
      p.conn.end();
    }
    this.peers.clear();
    this.order = [];
    this.opts.onClosed?.(reason);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ── helpers ──

  private members(): Member[] {
    return this.order.map((n) => this.peers.get(n)!.member);
  }

  /** Succession order: longest-standing members first, excluding the current host. */
  private successors(): string[] {
    return this.order.filter((n) => n !== this.room.hostNode);
  }

  private removePeer(node: string, silent: boolean): void {
    this.peers.delete(node);
    this.order = this.order.filter((n) => n !== node);
    if (!silent) this.opts.onInfo?.(this.info());
  }

  private broadcastRoster(): void {
    this.broadcast('members', { members: this.members(), successors: this.successors() });
    this.opts.onInfo?.(this.info());
  }

  private broadcast<T extends ControlType>(t: T, d: ControlFrames[T]): void {
    for (const p of this.peers.values()) p.conn.send(t, d);
  }

  private sysMessage(text: string): ChatMessage {
    return { id: `hub-${this.room.id}-${Date.now()}-${++this.sysSeq}`, from: 'hub', nick: '', kind: 'system', text, ts: Date.now() };
  }

  private system(text: string): void {
    const m = this.sysMessage(text);
    this.pushHistory(m);
    this.broadcast('msg', m);
  }

  private systemTo(peer: Peer, text: string): void {
    peer.conn.send('msg', this.sysMessage(text));
  }

  private pushHistory(m: ChatMessage): void {
    this.history.push(m);
    if (this.history.length > this.historySize) this.history = this.history.slice(-this.historySize);
  }
}
