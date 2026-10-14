import dgram from 'node:dgram';
import {
  DISCOVERY_PORT,
  MAGIC,
  MULTICAST_GROUP,
  PROTOCOL_VERSION,
  type Beacon,
  type BeaconKind,
  type RoomInfo,
} from '../../protocol/types.js';
import { normalizeIP } from '../../protocol/framing.js';
import type { DiscoveredRoom, Discovery, DiscoverySnapshot } from '../types.js';
import { ipv4Interfaces } from './net-utils.js';

export interface LanDiscoveryOptions {
  port?: number;
  /** How often to announce. */
  intervalMs?: number;
  /** Forget a node after this long without a beacon. */
  ttlMs?: number;
}

/**
 * Zero-config discovery over UDP.
 *
 * Every node announces itself every `intervalMs` to the limited broadcast
 * address, each interface's directed broadcast address and a site-local
 * multicast group (with loopback on, so several instances on one machine see
 * each other). Receivers keep a soft-state table that expires after `ttlMs`,
 * so crashed hosts disappear on their own; graceful exits send `bye`.
 */
export class LanDiscovery implements Discovery {
  private sock: dgram.Socket | null = null;
  private self = { node: '', nick: '' };
  private hosted: RoomInfo[] = [];
  private rooms = new Map<string, DiscoveredRoom>();
  private nodes = new Map<string, number>(); // node → lastSeen
  private listeners = new Set<(s: DiscoverySnapshot) => void>();
  private timers: NodeJS.Timeout[] = [];
  private lastEmitted = '';
  private readonly port: number;
  private readonly intervalMs: number;
  private readonly ttlMs: number;

  constructor(opts: LanDiscoveryOptions = {}) {
    this.port = opts.port ?? DISCOVERY_PORT;
    this.intervalMs = opts.intervalMs ?? 2000;
    this.ttlMs = opts.ttlMs ?? 7000;
  }

  async start(self: { node: string; nick: string }): Promise<void> {
    this.self = { ...self };
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('message', (buf, rinfo) => this.onDatagram(buf, normalizeIP(rinfo.address)));
    sock.on('error', () => {
      /* transient send errors (no route, iface down) are expected; keep going */
    });
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(this.port, () => {
        sock.off('error', reject);
        resolve();
      });
    });
    sock.setBroadcast(true);
    sock.setMulticastTTL(1);
    sock.setMulticastLoopback(true);
    this.joinGroups();

    this.timers.push(setInterval(() => this.send('announce'), this.intervalMs));
    this.timers.push(setInterval(() => this.sweep(), 1000));
    // Interfaces come and go (Wi-Fi roaming, VPN up/down): rejoin periodically.
    this.timers.push(setInterval(() => this.joinGroups(), 30_000));
    for (const t of this.timers) t.unref();
    this.send('announce');
    this.send('query');
  }

  setRooms(rooms: RoomInfo[]): void {
    this.hosted = rooms;
    this.send('announce');
  }

  setNick(nick: string): void {
    this.self.nick = nick;
  }

  query(): void {
    this.send('query');
  }

  onUpdate(listener: (s: DiscoverySnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (!this.sock) return;
    this.hosted = [];
    await this.sendAndWait('bye');
    this.sock.close();
    this.sock = null;
  }

  // ── internals ──

  private joinGroups(): void {
    if (!this.sock) return;
    const addrs = ['127.0.0.1', ...ipv4Interfaces().map((i) => i.address)];
    for (const addr of addrs) {
      try {
        this.sock.addMembership(MULTICAST_GROUP, addr);
      } catch {
        /* already a member, or interface lacks multicast */
      }
    }
  }

  private beacon(kind: BeaconKind): Buffer {
    const b: Beacon = { m: MAGIC, v: PROTOCOL_VERSION, k: kind, node: this.self.node, nick: this.self.nick, ts: Date.now() };
    if (kind === 'announce' && this.hosted.length) b.rooms = this.hosted;
    return Buffer.from(JSON.stringify(b));
  }

  private targets(): string[] {
    const set = new Set<string>([MULTICAST_GROUP, '255.255.255.255']);
    for (const i of ipv4Interfaces()) set.add(i.broadcast);
    return [...set];
  }

  private send(kind: BeaconKind): void {
    const sock = this.sock;
    if (!sock) return;
    const buf = this.beacon(kind);
    for (const host of this.targets()) sock.send(buf, this.port, host, () => {});
  }

  private sendAndWait(kind: BeaconKind): Promise<void> {
    const sock = this.sock;
    if (!sock) return Promise.resolve();
    const buf = this.beacon(kind);
    const sends = this.targets().map((host) => new Promise<void>((r) => sock.send(buf, this.port, host, () => r())));
    return Promise.race([Promise.all(sends).then(() => {}), new Promise<void>((r) => setTimeout(r, 300))]);
  }

  private onDatagram(buf: Buffer, address: string): void {
    let b: Beacon;
    try {
      b = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (b?.m !== MAGIC || b.v !== PROTOCOL_VERSION || typeof b.node !== 'string') return;
    const now = Date.now();

    if (b.k === 'bye') {
      this.nodes.delete(b.node);
      for (const [id, r] of this.rooms) if (r.node === b.node) this.rooms.delete(id);
      this.emit();
      return;
    }

    this.nodes.set(b.node, now);
    if (b.k === 'query') {
      // Jitter so a room full of hosts doesn't answer in one burst.
      if (this.hosted.length && b.node !== this.self.node) {
        setTimeout(() => this.send('announce'), Math.random() * 150).unref();
      }
      this.emit();
      return;
    }

    if (b.k === 'announce') {
      const announced = new Set<string>();
      for (const r of Array.isArray(b.rooms) ? b.rooms : []) {
        if (!r || typeof r.id !== 'string' || typeof r.port !== 'number') continue;
        announced.add(r.id);
        this.rooms.set(r.id, { ...r, name: String(r.name).slice(0, 48), address, node: b.node, lastSeen: now });
      }
      // A node that stops listing a room no longer hosts it (closed or handed over).
      for (const [id, r] of this.rooms) if (r.node === b.node && !announced.has(id)) this.rooms.delete(id);
      this.emit();
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, r] of this.rooms) if (r.lastSeen < cutoff || (r.exp && r.exp < Date.now())) this.rooms.delete(id);
    for (const [n, seen] of this.nodes) if (seen < cutoff) this.nodes.delete(n);
    this.emit();
  }

  private snapshot(): DiscoverySnapshot {
    const rooms = [...this.rooms.values()].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    return { rooms, nodes: this.nodes.size };
  }

  private emit(): void {
    const snap = this.snapshot();
    // Only notify on meaningful change (ignore lastSeen churn).
    const key = JSON.stringify([snap.nodes, snap.rooms.map((r) => [r.id, r.name, r.members, r.address, r.port, r.host, r.locked])]);
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    for (const l of this.listeners) l(snap);
  }
}
