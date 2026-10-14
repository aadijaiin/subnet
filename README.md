# subnet

**Zero-cloud LAN chat and file sharing, entirely in your terminal.**
Start it on two machines on the same network. They find each other, and you
can chat and send files directly. There is no server, no account, no browser
and no internet involved.

```
╭─────────────────────────╮╭──────────────────────────────────────────────────────────────╮
│ ROOMS            ⏎ join ││ # game night · you're hosting                                │
│ ●  game night        3  ││ 21:53 ── bob-2 joined (as bob-2; "bob" was taken)            │
│ 2  vault         1🔒⏳  ││ 21:53 bob │ hello alice! anyone up for a round?              │
│ ─────────────────────── ││ 21:53 * alice waves                                          │
│ PEERS                 3 ││ 21:53 [dm] bob-2 → you │ psst, I am the other bob            │
│ ★ alice (you)           ││ 21:53 alice │ [file] maps.zip 2.4 MB                         │
│   bob                   ││         /accept 5ffa9412  ·  /reject 5ffa9412   sha256 9146…     │
│   bob-2                 ││                                                              │
╰─────────────────────────╯╰──────────────────────────────────────────────────────────────╯
╭─────────────────────────────────────────────────────────────────────────────────────────╮
│ ↓ dataset.bin      ███░░░░░░░░░░░░░░░░░░░░░░░░░  10% 256 MB/s  ETA 4s from alice        │
╰─────────────────────────────────────────────────────────────────────────────────────────╯
╭─────────────────────────────────────────────────────────────────────────────────────────╮
│ #game night › Message #game night — /send to share a file, /help for commands           │
╰─────────────────────────────────────────────────────────────────────────────────────────╯
● connected 1ms · host you │ alice@192.168.1.52:59128 │ lan · 3 nodes
```

## Install

Requires Node.js ≥ 22.

```bash
npm install -g @aadijaiin/subnet
subnet
```

On machine A, type `/host game night`. On machine B, run `subnet`, press
**Tab**, then **Enter**. To try it without installing: `npx @aadijaiin/subnet`.

To try it on one machine, open two terminals. Several instances share the
discovery port, and multicast loopback lets them see each other:

```bash
subnet --nick alice --host "game night"
subnet --nick bob --join "game night"
```

> **Firewall:** the first time, macOS asks whether to allow incoming
> connections for `node`; choose **Allow**. On Linux, open UDP 47820 and,
> if you pin them, the TCP ports set with `--ctrl-port` / `--file-port`
> (`ufw allow 47820/udp`).

## Commands

| Command | |
|---|---|
| `/rooms` or **Tab** | browse rooms on the LAN (↑↓, ⏎ to join, `n` new room, `r` refresh) |
| `/host <name> [-p pass] [-t 30m]` | create a room; `-p` sets a passcode, `-t` makes it ephemeral |
| `/join <#\|name> [pass]` | join by list number or name (you'll be prompted if a passcode is needed) |
| `/connect <ip:port> [pass]` | join by address: VPNs, Tailscale, networks that block broadcast |
| `/leave` | leave; if you're the host, the room passes to the longest-standing member |
| `/nick <name>` · `/me <action>` · `/dm <nick> <text>` | identity, emotes, private messages |
| `/send [path] [@nick]` or **Ctrl+O** | share a file with the room or one peer; no path opens the file picker |
| `/accept [id]` · `/reject [id]` · `/cancel [id]` | manage transfers (no id means the latest one) |
| `/paste [@nick]` | send your clipboard as a message, multi-line intact |
| `/who` · `/transfers` · `/clear` · `/help` · `/quit` | |

**Keys:** PgUp/PgDn or Shift+↑↓ scroll · ↑↓ input history · Ctrl+W / Alt+⌫
delete word · Ctrl+A/E start/end · Ctrl+R refresh rooms · Esc jump to latest ·
Ctrl+C quit. Drag a file into the terminal after `/send ` and the escaped
path is handled.

**Flags:** `--nick`, `--downloads <dir>` (default `~/Downloads/subnet`),
`--host`, `--join`, `--connect`, `--pass`, `--ttl`, `--auto-accept`,
`--no-discovery`, `--port`, `--ctrl-port`, `--file-port`. Run
`subnet --help` for the full list.

## Tech stack: TypeScript + Node.js + React Ink

* **Socket performance where it matters.** Node's libuv event loop is built
  for this workload: many concurrent, mostly idle connections with bursts of
  I/O. File transfers stream through `fs` and `net` with real backpressure,
  so memory stays flat for a 100 GB file. In testing, a 1 GB loopback
  transfer ran at about 250 MB/s while chat round-trip time stayed at 1 ms.
  The bottleneck on a real LAN is the wire.
* **A UI that stays responsive.** Ink brings React's declarative model to the
  terminal. State flows one way (engine → store → `useSyncExternalStore`), the
  store coalesces updates to at most 30 per second, and the chat feed is
  pre-wrapped and virtualised, so only visible lines render.
* **The extensibility the brief asks for.** TypeScript interfaces make
  `TransportAdapter` a real seam. Every Node `Duplex` (TCP, TLS, a tunnel
  stream, a WebSocket multiplex) plugs in unchanged.
* **Trade-off accepted.** Go + Bubble Tea would ship as a single static
  binary. Here peers need Node ≥ 22 installed. In exchange, the UI layer is
  easier to evolve, and the protocol is plain JSON that any language can
  implement.

## Architecture in one paragraph

Each room is a **star with a portable centre**. The host runs a `Hub` that
authenticates members (HMAC challenge, so passcodes never cross the wire),
stamps one total order on messages, and fans them out. Every member,
including the host's own UI over loopback, connects with the same
`RoomClient`. The hub continuously publishes a **succession list**. If the
host leaves or crashes, every member independently agrees who is next, and
that node starts a new hub with the same room id and history, without an
election round. **Files never touch the hub.** Recipients pull directly from
the sender's file port in 64 KiB frames and verify SHA-256 as they stream.
Read more in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (layers, state
management, adapter guide) and [docs/PROTOCOL.md](docs/PROTOCOL.md) (every
byte on the wire).

## Additional features

These go beyond the brief. All are implemented, and most are covered by the
integration tests.

1. **Seamless leader handover.** `/leave` as host, or kill the host's
   process: the room continues on the longest-standing member, with history
   intact. Peers reconnect automatically. The discovery list updates within
   one beacon interval.
2. **Offline message queuing, in two layers.**
   * *Client outbox:* messages you type while reconnecting show as
     `(sending…)`. They are delivered exactly once when the room comes back
     (the hub dedupes by message id).
   * *Hub mailbox:* DMs to a peer who just dropped are held and delivered
     when they rejoin, and the sender is told the message was queued.
3. **Collision-free identities.** The hub assigns unique nicknames
   (`bob` → `bob-2`, case-insensitive), lets a reconnecting node reclaim its
   nick, and gives each node a deterministic colour that matches on every
   screen.
4. **Ephemeral rooms.** `/host party -t 30m` advertises its expiry. The
   sidebar shows a live countdown, and the room deletes itself, for every
   member and from discovery, when time runs out. Handover keeps the
   deadline.
5. **Resumable, verified transfers.** Interrupted downloads keep their
   `.part` file. `/accept <id>` resumes from the last byte by re-hashing the
   prefix locally. Corrupt results are discarded, never saved.
6. **Clipboard paste and bracketed paste.** `/paste` sends the system
   clipboard (pbpaste / wl-paste / xclip / PowerShell). Pasting into the input
   keeps newlines, so code snippets arrive intact.

## Security notes

LAN-first does not mean trusting everything on the LAN:

* Passcodes are verified with an HMAC challenge, compared in constant time.
* File fetches require a 128-bit capability token from the offer.
* Remote filenames are reduced to a safe basename.
* Remote text has terminal escape sequences stripped, so a peer can't clear
  your screen or retitle your terminal.
* Frames are size-limited, and malformed input closes the connection.

Traffic is **not encrypted** in v1. The transport seam is where a
Noise/TLS-PSK layer goes; see ARCHITECTURE.md.

## Development

```bash
git clone https://github.com/aadijaiin/subnet && cd subnet && npm install
npm run dev          # run from source with tsx
npm test             # 20 tests: real UDP/TCP between in-process engines
npm run typecheck
npm run format
```

**Releasing:** `npm version patch|minor|major`, then `npm publish`.
`prepublishOnly` runs the typecheck and the full test suite, and `prepack`
does a clean build. Only `dist/`, `docs/`, `README.md` and `LICENSE` are
shipped (see `files` in package.json). Run `npm pack --dry-run` to preview.

The engine tests run three engines on a private discovery port. They cover
discovery, nick collisions, chat acks, DM privacy, file transfer, resume,
graceful handover, crash takeover with outbox flush, offline DM delivery,
passcodes, and ephemeral expiry.
