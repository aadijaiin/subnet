# Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ TUI  (src/tui)  React + Ink                                          │
│  App ─ Sidebar · ChatView · TextInput · TransferTray · FilePicker    │
│        reads ▲ useSyncExternalStore         calls ▼ engine API       │
├────────────────┴──────────────────────────────────┴──────────────────┤
│ Store (src/store)        immutable AppState, ≤30 notifications/s     │
├──────────────────────────────────────────▲───────────────────────────┤
│ Engine (src/engine)                       │ writes                   │
│   Engine ─ room lifecycle, outbox, handover, lookups                 │
│   Hub ──── authoritative relay for a hosted room (star topology)     │
│   RoomClient ─ one member's connection to a hub                      │
│ TransferService (src/transfer) ─ P2P file channel, SHA-256, resume   │
├──────────────────────────────────────────────────────────────────────┤
│ TransportAdapter (src/transport/types.ts)                            │
│   listen(port) · dial(host, port) · localAddress() · discovery?      │
│   └─ LanTransport: TCP + LanDiscovery (UDP broadcast/multicast)      │
├──────────────────────────────────────────────────────────────────────┤
│ Protocol (src/protocol) ─ types, framing, crypto. No app imports.    │
└──────────────────────────────────────────────────────────────────────┘
```

Dependencies only point downward. The engine has never heard of Ink, and the
protocol module has never heard of the engine. The integration tests drive
`Engine` with no UI at all.

## Directory layout

```
src/
  cli.tsx                    entry point: flags, engine start, Ink render
  protocol/
    types.ts                 every wire structure + constants
    framing.ts               FrameDecoder, ControlConnection (typed frames over any Duplex)
    crypto.ts                ids, HMAC passcode proofs, streaming SHA-256
  transport/
    types.ts                 TransportAdapter / Discovery interfaces  ← the extension seam
    lan/LanTransport.ts      TCP listen/dial (+ discovery on/off)
    lan/discovery.ts         UDP beacons, soft-state room table
    lan/net-utils.ts         interface enumeration, directed broadcast
  store/Store.ts             AppState + throttled subscribe
  engine/
    Engine.ts                public API used by the UI
    Hub.ts                   server side of a room
    RoomClient.ts            client side of a room
    nick.ts                  sanitising + collision-free assignment
  transfer/TransferService.ts
  tui/
    App.tsx                  layout, focus modes, global keys
    commands.ts              slash-command parser → engine calls
    lines.ts                 message → wrapped terminal lines (exact scrolling)
    components/              Sidebar, ChatView, TextInput, TransferTray, StatusBar, FilePicker
  util/                      formatting, clipboard
test/
  engine.test.ts             real sockets: discovery, chat, files, handover, crash, passcode…
  protocol.test.ts           framing, security helpers, parsing
```

## Topology: a star with a portable centre

Each room has one **hub**, which runs on the hosting node. Members keep one
TCP connection to it. The host's own UI is not special: it joins its own hub
over `127.0.0.1` like any other client. That has two benefits:

* There is exactly one client code path, so it gets exercised all the time.
* Handover is just "a different node starts a `Hub`, and everyone dials it".

I chose a star over a full mesh deliberately:

| | star (this) | full mesh |
|-|-|-|
| connections per room | n | n(n−1)/2 |
| message ordering | the hub stamps `ts`, giving one total order | needs vector clocks or a CRDT |
| passcode enforcement | one gatekeeper | every peer |
| single point of failure | yes, *mitigated by handover* | no |

Bulk data never takes the star. **Files go point-to-point** between sender
and receiver over their own TCP connection. That keeps the hub's load
independent of file sizes.

## State management

`AppState` (in `src/store/Store.ts`) is the only thing the UI renders:

| Slice       | Contents                                                                       | Written by                                    |
|-------------|--------------------------------------------------------------------------------|-----------------------------------------------|
| `self`      | node id, nick, IP, control/file ports, transport name, download dir            | Engine start, welcome, nick changes           |
| `rooms`     | discovered rooms with source address and last-seen time                        | Discovery `onUpdate` (only on real changes)   |
| `lanNodes`  | number of live nodes seen on the LAN                                           | Discovery                                     |
| `room`      | the active room: `state`, `members`, `successors`, `messages`, `hosting`, `status`, `rttMs`, `hostAddr` | RoomClient events via Engine |
| `lobby`     | notices shown while not in a room                                              | `store.notice()`                              |
| `transfers` | the transfer queue: one entry per offer or download, plus one per recipient upload (`xfer>node`) | TransferService |

Rules:

* **Immutable updates.** Every write produces new objects along the changed
  path. React uses reference equality, so `useMemo(buildLines)` re-runs only
  when the message array or the terminal width changes.
* **Throttled notifications.** Writes are cheap and synchronous. Listeners
  fire at most once per 33 ms, so a 250 MB/s transfer updating progress
  hundreds of times per second costs roughly 30 renders per second.
* **Messages are keyed by id.** `upsertMessage` replaces a pending message
  with its acknowledged copy. History replayed after a reconnect merges
  without duplicates. Unacknowledged messages stay at the bottom.
* **Session generations.** `Engine.gen` increments whenever the active
  connection changes. Every callback from a RoomClient checks it first, so
  events from a dead connection can never touch the current room.

## Engine flows

**Host:** `host(name)` creates a `RoomState`, starts a `Hub` on the node's
control listener, publishes `hub.info()` to discovery, then joins the room
over loopback.

**Join:** `join(ref)` resolves the room from discovery (by list number, id or
name), then a `RoomClient` performs the challenge/hello/welcome exchange. Any
frames that arrive in the same TCP segment as `welcome` are buffered until the
engine subscribes (`client.start()`), so none are lost.

**Recover:** see `Engine.recover()` and
[PROTOCOL.md §2.3](PROTOCOL.md#23-host-handover). Messages typed during
recovery queue in the outbox and flush on the next `welcome`.

## Writing a transport adapter

The engine needs only four things from a transport:

```ts
interface TransportAdapter {
  readonly name: string;
  listen(port: number, onStream: (s: Stream) => void): Promise<Listener>;
  dial(host: string, port: number, timeoutMs?: number): Promise<Stream>;
  localAddress(): string;
  readonly discovery: Discovery | null;
}
```

`Stream` is any Node `Duplex`, which includes a TCP socket, a TLS socket, a
`tsnet` connection, or a multiplexed stream over a WebSocket.

**Tailscale / WireGuard / ZeroTier** works today with no code:
`subnet --no-discovery`, then `/connect 100.x.y.z:<port>`. Overlay networks
carry TCP unchanged.

**Relay / tunnel (e.g. Cloudflare Tunnel, ngrok).** Implement the
interface over the relay's stream API:

```ts
class RelayTransport implements TransportAdapter {
  readonly name = 'relay';
  readonly discovery = new RelayDiscovery(this.ws); // rooms listed by the relay server
  constructor(private ws: WebSocketMux) {}

  async listen(port: number, onStream: (s: Stream) => void) {
    // Register "node:port" with the relay; each incoming virtual stream → onStream
    const id = await this.ws.register(port, onStream);
    return { port: id, close: () => this.ws.unregister(id) };
  }
  dial(host: string, port: number) {
    return this.ws.open(`${host}:${port}`); // resolves to a Duplex
  }
  localAddress() {
    return this.ws.nodeId; // what peers should dial to reach us
  }
}
```

Then pass it to `new Engine({ transport: new RelayTransport(mux), … })`. The
hub, handover, outbox and file transfer all work unchanged, because they only
ever speak in streams and `host:port` strings.

**End-to-end encryption** fits at the same seam. Wrap each `Stream` returned
by `listen`/`dial` in a Noise or TLS-PSK session derived from the room
passcode, and nothing above it needs to change.

**Persistence** fits at the store seam. Subscribe to the `Store` and
append `room.messages` to SQLite. On `host()`, seed `Hub` with
`history` loaded from disk; the constructor already accepts it, which is how
handover carries history today.
