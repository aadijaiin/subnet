import { EventEmitter } from 'node:events';
import { proof } from '../protocol/crypto.js';
import { ControlConnection } from '../protocol/framing.js';
import {
  PROTOCOL_VERSION,
  type ChatMessage,
  type ControlFrames,
  type ControlType,
  type Hello,
  type MembersUpdate,
  type RoomClosed,
  type Welcome,
} from '../protocol/types.js';
import type { TransportAdapter } from '../transport/types.js';

export class JoinError extends Error {
  constructor(
    message: string,
    readonly code: 'passcode-required' | 'passcode' | 'room' | 'version' | 'full' | 'protocol' | 'network',
  ) {
    super(message);
  }
}

export interface RoomClientEvents {
  msg: [ChatMessage];
  members: [MembersUpdate];
  closed: [RoomClosed];
  rtt: [number];
  /** Connection dropped without us asking. */
  lost: [];
}

const PING_EVERY = 3000;
const DEAD_AFTER = 10_000;

/** One member's control connection to a room hub. */
export class RoomClient extends EventEmitter<RoomClientEvents> {
  private conn: ControlConnection | null = null;
  private leaving = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPong = Date.now();
  /** Frames that arrived right behind `welcome`, held until the owner calls start(). */
  private backlog: [ControlType, unknown][] | null = [];

  constructor(
    private readonly transport: TransportAdapter,
    readonly host: string,
    readonly port: number,
  ) {
    super();
  }

  /**
   * Dial, answer the challenge, and wait for welcome.
   * `expectedRoom` guards against a different room now living on that port.
   */
  async connect(hello: Omit<Hello, 'v' | 'proof'>, passcode: string, expectedRoom?: string): Promise<Welcome> {
    let stream;
    try {
      stream = await this.transport.dial(this.host, this.port);
    } catch (err) {
      throw new JoinError((err as Error).message, 'network');
    }
    const conn = new ControlConnection(stream);
    this.conn = conn;
    // Register before awaiting anything: the hub often sends `welcome` and the
    // next `msg` in one TCP segment, and they're emitted synchronously.
    conn.onFrame((t, d) => {
      if (t === 'challenge' || t === 'welcome' || t === 'reject') return;
      if (this.backlog) this.backlog.push([t, d]);
      else this.onFrame(t, d);
    });
    try {
      const first = await conn.next(['challenge', 'reject'], 5000);
      if (first.t === 'reject') {
        const r = first.d as ControlFrames['reject'];
        throw new JoinError(r.reason, r.code);
      }
      const ch = first.d as ControlFrames['challenge'];
      if (expectedRoom && ch.room !== expectedRoom) throw new JoinError('that room is no longer hosted there', 'room');
      if (ch.locked && !passcode) throw new JoinError('room is passcode-protected', 'passcode-required');
      conn.send('hello', { ...hello, v: PROTOCOL_VERSION, ...(ch.locked && { proof: proof(passcode, ch.nonce) }) });
      const res = await conn.next(['welcome', 'reject'], 5000);
      if (res.t === 'reject') {
        const r = res.d as ControlFrames['reject'];
        throw new JoinError(r.reason, r.code);
      }
      return res.d as Welcome;
    } catch (err) {
      conn.destroy();
      this.conn = null;
      if (err instanceof JoinError) throw err;
      throw new JoinError((err as Error).message, 'network');
    }
  }

  /** Begin delivering events (call after subscribing) and start the heartbeat. */
  start(): void {
    const conn = this.conn;
    if (!conn || !this.backlog) return;
    const queued = this.backlog;
    this.backlog = null;
    for (const [t, d] of queued) this.onFrame(t, d as never);
    if (conn.isClosed) {
      if (!this.leaving) this.emit('lost');
      return;
    }
    conn.on('close', () => {
      this.stopPing();
      if (!this.leaving) this.emit('lost');
    });
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > DEAD_AFTER) {
        conn.destroy(new Error('hub stopped responding'));
        return;
      }
      conn.send('ping', { ts: Date.now() });
    }, PING_EVERY);
    this.pingTimer.unref();
    conn.send('ping', { ts: Date.now() });
  }

  private onFrame<T extends ControlType>(t: T, d: ControlFrames[T]): void {
    switch (t) {
      case 'msg':
        this.emit('msg', d as ChatMessage);
        break;
      case 'members':
        this.emit('members', d as MembersUpdate);
        break;
      case 'pong':
        this.lastPong = Date.now();
        this.emit('rtt', Date.now() - (d as { ts: number }).ts);
        break;
      case 'room_closed':
        this.leaving = true; // the hub is closing on purpose; don't treat as a loss
        this.emit('closed', d as RoomClosed);
        break;
    }
  }

  send<T extends ControlType>(t: T, d?: ControlFrames[T]): boolean {
    return this.conn?.send(t, d) ?? false;
  }

  get connected(): boolean {
    return !!this.conn && !this.conn.isClosed;
  }

  /** Graceful leave. */
  close(): void {
    this.leaving = true;
    this.stopPing();
    if (!this.conn) return;
    this.conn.send('leave', {});
    this.conn.end();
  }

  /** Drop without ceremony. */
  destroy(): void {
    this.leaving = true;
    this.stopPing();
    this.conn?.destroy();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
