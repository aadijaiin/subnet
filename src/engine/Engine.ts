import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { randomId } from '../protocol/crypto.js';
import { ControlConnection } from '../protocol/framing.js';
import {
  MAX_TEXT,
  type ChatMessage,
  type Member,
  type MembersUpdate,
  type RoomClosed,
  type RoomState,
  type Welcome,
} from '../protocol/types.js';
import { Store, type ActiveRoom, type UIMessage } from '../store/Store.js';
import { TransferService } from '../transfer/TransferService.js';
import type { Listener, Stream, TransportAdapter } from '../transport/types.js';
import { Hub } from './Hub.js';
import { sanitizeNick } from './nick.js';
import { JoinError, RoomClient } from './RoomClient.js';

export { JoinError };

export interface EngineOptions {
  nick: string;
  transport: TransportAdapter;
  downloadDir: string;
  ctrlPort?: number;
  filePort?: number;
  /** Fetch incoming files without asking (up to `autoAcceptMaxBytes`). */
  autoAccept?: boolean;
  autoAcceptMaxBytes?: number;
}

export interface HostOptions {
  passcode?: string;
  /** Ephemeral room: auto-destructs after this many ms. */
  ttlMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The application core. Owns the network (via a TransportAdapter), the
 * room lifecycle, the outbox and file transfers, and publishes everything
 * to the Store. It has no knowledge of the terminal: the TUI is one client
 * of this API; a bot, a test or a GUI could be another.
 */
export class Engine {
  readonly node = randomId(6);
  readonly store: Store;
  private readonly transport: TransportAdapter;
  private readonly transfers: TransferService;
  private ctrl: Listener | null = null;
  private hub: Hub | null = null;
  private client: RoomClient | null = null;
  /** Bumped whenever the active session changes; stale callbacks compare against it. */
  private gen = 0;
  private passcode = '';
  private seq = 0;
  /** Messages sent but not yet acknowledged by the hub, resent after reconnect. */
  private outbox = new Map<string, ChatMessage>();
  private recovering = false;
  private discoveryOff: (() => void) | null = null;
  /** Everyone seen in the current room, so DMs can reach peers who just dropped (the hub queues them). */
  private seenPeers = new Map<string, Member>();

  constructor(private readonly opts: EngineOptions) {
    this.transport = opts.transport;
    this.store = new Store({
      node: this.node,
      nick: sanitizeNick(opts.nick),
      ip: this.transport.localAddress(),
      ctrlPort: 0,
      filePort: 0,
      transport: this.transport.name,
      downloadDir: opts.downloadDir,
    });
    this.transfers = new TransferService({
      transport: this.transport,
      store: this.store,
      node: this.node,
      downloadDir: opts.downloadDir,
      nickOf: (node) => this.member(node)?.nick ?? node.slice(0, 6),
    });
  }

  // ── lifecycle ──

  async start(): Promise<void> {
    this.ctrl = await this.transport.listen(this.opts.ctrlPort ?? 0, (s) => this.onInbound(s));
    const filePort = await this.transfers.start(this.opts.filePort ?? 0);
    this.store.setSelf({ ctrlPort: this.ctrl.port, filePort });
    const d = this.transport.discovery;
    if (d) {
      this.discoveryOff = d.onUpdate((snap) => this.store.update((s) => ({ ...s, rooms: snap.rooms, lanNodes: snap.nodes })));
      await d.start({ node: this.node, nick: this.nick });
    }
  }

  async stop(): Promise<void> {
    this.leave(true);
    this.discoveryOff?.();
    await Promise.allSettled([this.transport.discovery?.stop(), this.transfers.stop(), this.ctrl?.close()]);
  }

  get nick(): string {
    return this.store.get().self.nick;
  }

  get hosting(): boolean {
    return !!this.hub && !this.hub.isClosed;
  }

  private onInbound(stream: Stream): void {
    if (this.hub && !this.hub.isClosed) return this.hub.accept(stream);
    const conn = new ControlConnection(stream);
    conn.send('reject', { code: 'room', reason: 'no room is hosted at this address' });
    conn.end();
  }

  // ── rooms ──

  /** Create a room on this node and join it. */
  async host(name: string, o: HostOptions = {}): Promise<void> {
    if (!this.ctrl) throw new Error('engine not started');
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 48);
    if (!clean) throw new Error('room name required');
    this.leave(true);
    const state: RoomState = {
      id: randomId(5),
      name: clean,
      locked: !!o.passcode,
      created: Date.now(),
      ...(o.ttlMs && { exp: Date.now() + o.ttlMs }),
      hostNode: this.node,
    };
    this.startHub(state, o.passcode ?? '', []);
    try {
      await this.enterRoom('127.0.0.1', this.ctrl.port, state.id, o.passcode ?? '');
    } catch (err) {
      this.hub?.shutdown(false);
      this.hub = null;
      throw err;
    }
  }

  /** Join a discovered room by list number (1-based), id, or name. */
  async join(ref: string, passcode = ''): Promise<void> {
    const room = this.findRoom(ref);
    if (!room) throw new Error(`no room matching "${ref}" — try /rooms`);
    const current = this.store.get().room;
    if (current?.state.id === room.id && current.status === 'connected') throw new Error(`already in ${room.name}`);
    if (room.locked && !passcode) throw new JoinError('room is passcode-protected', 'passcode-required');
    this.leave(true);
    await this.enterRoom(room.address, room.port, room.id, passcode);
  }

  /** Join whatever room is hosted at host:port (works without discovery, e.g. over a VPN). */
  async connect(addr: string, passcode = ''): Promise<void> {
    const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(addr.trim());
    if (!m) throw new Error('usage: /connect <host:port> [passcode]');
    this.leave(true);
    await this.enterRoom(m[1], Number(m[2]), undefined, passcode);
  }

  findRoom(ref: string) {
    const rooms = this.store.get().rooms;
    const r = ref.replace(/^#/, '').trim().toLowerCase();
    if (/^\d+$/.test(r) && Number(r) >= 1 && Number(r) <= rooms.length) return rooms[Number(r) - 1];
    return (
      rooms.find((x) => x.id === r) ??
      rooms.find((x) => x.name.toLowerCase() === r) ??
      rooms.find((x) => x.name.toLowerCase().startsWith(r))
    );
  }

  /** Leave the current room. Hosts hand the room to the longest-standing member. */
  leave(silent = false): void {
    const room = this.store.get().room;
    this.gen++;
    this.client?.close();
    this.client = null;
    if (this.hub) {
      const hub = this.hub;
      this.hub = null;
      hub.shutdown(true);
    }
    this.outbox.clear();
    if (room) {
      this.dropStaleOffers();
      this.store.update((s) => ({ ...s, room: null }));
      if (!silent) this.store.notice(`Left ${room.state.name}${room.hosting ? ' (handed over to the next member)' : ''}`);
    }
  }

  private startHub(state: RoomState, passcode: string, history: ChatMessage[]): Hub {
    const d = this.transport.discovery;
    const hub: Hub = new Hub({
      room: state,
      passcode,
      history,
      port: this.ctrl!.port,
      localAddress: () => this.transport.localAddress(),
      onInfo: (info) => {
        if (this.hub === hub) d?.setRooms([info]);
      },
      onClosed: () => {
        if (this.hub === hub) this.hub = null;
        if (!this.hub) d?.setRooms([]);
      },
    });
    this.hub = hub;
    d?.setRooms([hub.info()]);
    return hub;
  }

  /** Connect to a hub and make it the active session. */
  private async enterRoom(host: string, port: number, expectedRoom: string | undefined, passcode: string): Promise<Welcome> {
    const client = new RoomClient(this.transport, host, port);
    const self = this.store.get().self;
    const welcome = await client.connect(
      { node: this.node, nick: self.nick, ctrlPort: self.ctrlPort, filePort: self.filePort },
      passcode,
      expectedRoom,
    );

    // Commit.
    this.client?.destroy();
    this.client = client;
    this.passcode = passcode;
    const gen = ++this.gen;
    const live = () => gen === this.gen;
    client.on('msg', (m) => live() && this.onMessage(m, true));
    client.on('members', (u) => live() && this.onMembers(u));
    client.on('rtt', (rtt) => live() && this.store.setRoom((r) => ({ ...r, rttMs: rtt })));
    client.on('closed', (info) => live() && void this.recover(info));
    client.on('lost', () => live() && void this.recover());

    const hosting = !!this.hub && this.hub.room.id === welcome.room.id;
    const prev = this.store.get().room;
    const sameRoom = prev?.state.id === welcome.room.id;
    const history: UIMessage[] = welcome.history;
    this.store.update((s) => {
      const base: ActiveRoom = {
        state: welcome.room,
        members: welcome.members,
        successors: welcome.successors,
        messages: sameRoom ? prev!.messages : [],
        hosting,
        status: 'connected',
        rttMs: null,
        hostAddr: `${host}:${port}`,
      };
      return { ...s, self: { ...s.self, nick: welcome.you.nick }, room: base };
    });
    this.store.mergeMessages(history);
    for (const m of history) this.onMessage(m, false);
    this.transport.discovery?.setNick(welcome.you.nick);

    if (!sameRoom) {
      this.dropStaleOffers();
      this.seenPeers.clear();
    }
    this.rememberPeers(welcome.members);
    client.start();

    // Flush the outbox: anything typed while disconnected goes out now.
    for (const m of this.outbox.values()) client.send('msg', m);
    return welcome;
  }

  private onMessage(m: ChatMessage, live: boolean): void {
    if (!m || typeof m.id !== 'string') return;
    if (m.from === this.node) this.outbox.delete(m.id);
    if (live) this.store.upsertMessage(m);
    if (m.kind === 'file' && m.file && m.from !== this.node && (!m.to || m.to === this.node)) {
      // Offers from history are only surfaced in the tray if recent; older ones can still be /accept-ed.
      if (!live && Date.now() - m.ts > 15 * 60_000) return;
      const t = this.transfers.registerOffer(m.file, { node: m.from, nick: m.nick });
      if (t && live && this.opts.autoAccept && t.size <= (this.opts.autoAcceptMaxBytes ?? 512 * 1024 * 1024)) {
        void this.accept(t.id).catch(() => {});
      }
    }
  }

  private rememberPeers(members: Member[]): void {
    for (const m of members) {
      for (const [k, v] of this.seenPeers) if (v.node === m.node) this.seenPeers.delete(k);
      this.seenPeers.set(m.nick.toLowerCase(), m);
    }
  }

  private onMembers(u: MembersUpdate): void {
    this.rememberPeers(u.members);
    const me = u.members.find((m) => m.node === this.node);
    this.store.update((s) =>
      s.room
        ? {
            ...s,
            self: me ? { ...s.self, nick: me.nick } : s.self,
            room: { ...s.room, members: u.members, successors: u.successors, hosting: this.hosting },
          }
        : s,
    );
    if (me) this.transport.discovery?.setNick(me.nick);
  }

  /**
   * Leader handover / reconnect. Runs when the connection to the hub drops
   * or the hub announces it is closing.
   *
   * Every member holds the same succession list (join order, published by
   * the hub with each roster change), so every member independently arrives
   * at the same answer to "who hosts next?" without an election round:
   *   1. graceful close with a named successor → dial it
   *   2. abrupt loss → retry the old host briefly (it may be a blip), then
   *      walk the succession list; whoever finds *itself* first takes over.
   */
  private async recover(info?: RoomClosed): Promise<void> {
    if (this.recovering) return;
    const room = this.store.get().room;
    if (!room) return;
    this.recovering = true;
    const gen = ++this.gen;
    this.client?.destroy();
    this.client = null;
    try {
      if (info && !info.handover) {
        this.endRoom(`${room.state.name} closed: ${info.reason}`);
        return;
      }
      this.store.setRoom((r) => ({ ...r, status: 'reconnecting', rttMs: null, hosting: false }));
      const oldHost = room.members.find((m) => m.host);
      type Candidate = { m: Member; attempts: number };
      const candidates: Candidate[] = info?.handover
        ? [{ m: info.handover, attempts: 12 }]
        : [
            ...(oldHost ? [{ m: oldHost, attempts: 2 }] : []),
            ...room.successors
              .filter((n) => n !== oldHost?.node)
              .map((n) => room.members.find((m) => m.node === n))
              .filter((m): m is Member => !!m)
              .map((m) => ({ m, attempts: 10 })),
          ];
      this.store.notice(
        info?.handover ? `Host left — handing the room to ${info.handover.nick}…` : 'Connection to host lost — reconnecting…',
        'warn',
      );

      for (const c of candidates) {
        if (gen !== this.gen) return; // user moved on
        if (c.m.node === this.node) {
          if (this.hub && !this.hub.isClosed) {
            await this.enterRoom('127.0.0.1', this.ctrl!.port, room.state.id, this.passcode);
          } else {
            await this.takeOver(
              room,
              info?.handover ? 'The host left — you are now hosting this room' : 'The host is unreachable — you are now hosting this room',
            );
          }
          return;
        }
        for (let i = 0; i < c.attempts; i++) {
          if (gen !== this.gen) return;
          try {
            await this.enterRoom(c.m.ip, c.m.ctrlPort, room.state.id, this.passcode);
            this.store.notice(c.m.node === oldHost?.node ? 'Reconnected' : `Reconnected — ${c.m.nick} is now hosting`);
            return;
          } catch (err) {
            if (err instanceof JoinError && ['passcode', 'version'].includes(err.code)) break;
            await sleep(500);
          }
        }
      }
      if (gen === this.gen) this.endRoom(`Lost ${room.state.name}: no host could be reached`);
    } catch (err) {
      if (gen === this.gen) this.endRoom(`Lost ${room.state.name}: ${(err as Error).message}`);
    } finally {
      this.recovering = false;
    }
  }

  private async takeOver(room: ActiveRoom, reason: string): Promise<void> {
    const state: RoomState = { ...room.state, hostNode: this.node };
    const history = room.messages.filter((m) => !m.local && !m.pending).map(({ pending: _p, local: _l, level: _v, ...m }) => m);
    this.startHub(state, this.passcode, history);
    await this.enterRoom('127.0.0.1', this.ctrl!.port, state.id, this.passcode);
    this.store.notice(reason);
  }

  private endRoom(text: string): void {
    this.gen++;
    this.client?.destroy();
    this.client = null;
    if (this.hub) {
      const h = this.hub;
      this.hub = null;
      h.shutdown(false);
    }
    this.outbox.clear();
    this.store.update((s) => ({ ...s, room: null }));
    this.store.notice(text, 'warn');
  }

  /** Offers from a room we're no longer in can't be fetched; clear them from the tray. */
  private dropStaleOffers(): void {
    this.store.update((s) =>
      s.transfers.some((t) => t.state === 'offered') ? { ...s, transfers: s.transfers.filter((t) => t.state !== 'offered') } : s,
    );
  }

  refreshRooms(): void {
    this.transport.discovery?.query();
  }

  // ── messaging ──

  say(text: string): void {
    this.post('chat', text);
  }

  me(text: string): void {
    this.post('me', text);
  }

  dm(nick: string, text: string): void {
    const target = this.memberByNick(nick) ?? this.seenPeers.get(nick.replace(/^@/, '').toLowerCase());
    if (!target) throw new Error(`no one called ${nick} in this room`);
    if (target.node === this.node) throw new Error("that's you");
    this.post('dm', text, target.node);
  }

  private post(kind: ChatMessage['kind'], text: string, to?: string, file?: ChatMessage['file']): void {
    if (!this.store.get().room) throw new Error('not in a room — /rooms to browse, /host <name> to create one');
    if (text.length > MAX_TEXT) throw new Error(`message too long (max ${MAX_TEXT / 1024} KB)`);
    const m: ChatMessage = {
      id: `${this.node}-${++this.seq}`,
      from: this.node,
      nick: this.nick,
      kind,
      ts: Date.now(),
      ...(text && { text }),
      ...(to && { to }),
      ...(file && { file }),
    };
    this.outbox.set(m.id, m);
    this.store.upsertMessage({ ...m, pending: true });
    this.client?.send('msg', m);
  }

  setNick(nick: string): void {
    const clean = sanitizeNick(nick);
    if (this.client?.connected) {
      this.client.send('nick', { nick: clean });
    } else {
      this.store.setSelf({ nick: clean });
      this.transport.discovery?.setNick(clean);
      this.store.notice(`You are now ${clean}`);
    }
  }

  // ── files ──

  async sendFile(path: string, toNick?: string): Promise<void> {
    if (!this.store.get().room) throw new Error('join a room before sending files');
    const target = toNick ? this.memberByNick(toNick) : undefined;
    if (toNick && !target) throw new Error(`no one called ${toNick} in this room`);
    const abs = resolvePath(path.replace(/^~(?=$|\/)/, homedir()));
    const offer = await this.transfers.share(abs, { to: target?.node, peerLabel: target?.nick ?? 'room' });
    this.post('file', '', target?.node, offer);
  }

  /** Accept an incoming file (by id prefix, or the most recent offer). */
  async accept(prefix?: string): Promise<string> {
    const t = this.findTransfer(prefix, ['offered', 'failed'], 'down') ?? this.registerFromFeed(prefix);
    if (!t?.offer) throw new Error(prefix ? `no incoming file matching ${prefix}` : 'no pending file offers');
    const sender = t.peerNode ? this.member(t.peerNode) : undefined;
    if (!sender) throw new Error(`${t.peer} is no longer in the room, so ${t.name} can't be fetched`);
    await this.transfers.download(t.id, sender.ip, sender.filePort);
    return this.store.getTransfer(t.id)?.path ?? '';
  }

  reject(prefix?: string): void {
    const t = this.findTransfer(prefix, ['offered'], 'down');
    if (!t || !this.transfers.reject(t.id)) throw new Error('no matching offer');
  }

  cancel(prefix?: string): void {
    const t = this.findTransfer(prefix, ['hashing', 'active', 'waiting', 'verifying', 'done'], undefined);
    if (!t || !this.transfers.cancel(t.xfer)) throw new Error('no matching transfer');
  }

  private findTransfer(prefix: string | undefined, states: string[], dir: 'up' | 'down' | undefined) {
    const list = this.store
      .get()
      .transfers.filter((t) => states.includes(t.state) && (!dir || t.direction === dir) && (t.direction === 'down' || t.id === t.xfer));
    if (!prefix) return list.at(-1);
    return list.findLast((t) => t.xfer.startsWith(prefix.toLowerCase()));
  }

  /** Old offers from history aren't in the tray; find them in the feed. */
  private registerFromFeed(prefix?: string) {
    if (!prefix) return undefined;
    const m = this.store.get().room?.messages.findLast((x) => x.kind === 'file' && x.file?.xfer.startsWith(prefix) && x.from !== this.node);
    if (!m?.file) return undefined;
    return this.transfers.registerOffer(m.file, { node: m.from, nick: m.nick }) ?? this.store.getTransfer(m.file.xfer);
  }

  // ── lookups ──

  private member(node: string): Member | undefined {
    return this.store.get().room?.members.find((m) => m.node === node);
  }

  private memberByNick(nick: string): Member | undefined {
    const n = nick.replace(/^@/, '').toLowerCase();
    return this.store.get().room?.members.find((m) => m.nick.toLowerCase() === n);
  }
}
