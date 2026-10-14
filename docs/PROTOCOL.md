# subnet wire protocol (v1)

Three independent channels. All JSON is UTF-8. All integers in length
prefixes are unsigned 32-bit big-endian. The authoritative TypeScript
definitions live in [`src/protocol/types.ts`](../src/protocol/types.ts).

| Channel   | Transport | Port                        | Framing                                 |
|-----------|-----------|-----------------------------|-----------------------------------------|
| Discovery | UDP       | `47820` (shared by all)     | one JSON object per datagram            |
| Control   | TCP       | per-node, random by default | `[u32 len][JSON Envelope]`              |
| File      | TCP       | per-node, random by default | JSON handshake, then `[u32 len][bytes]` |

---

## 1. Discovery (UDP)

Every node binds UDP `47820` with `SO_REUSEADDR`/`SO_REUSEPORT` (so several
instances can share one machine) and sends each beacon to:

* `255.255.255.255` (limited broadcast)
* each interface's directed broadcast address (e.g. `192.168.1.255`)
* multicast group `239.255.71.71` with TTL 1 and loopback enabled

Receivers dedupe implicitly: beacons are idempotent soft state.

```jsonc
{
  "m": "SUBNET",          // magic: anything else is dropped
  "v": 1,                 // protocol version: mismatches are dropped
  "k": "announce",        // "announce" | "query" | "bye"
  "node": "9f2c41aa07be", // random per process
  "nick": "alice",
  "ts": 1760467200000,
  "rooms": [{             // only on "announce", only rooms this node hosts
    "id": "a1b2c3d4e5",
    "name": "game night",
    "locked": false,      // passcode required?
    "members": 3,
    "port": 59128,        // TCP control port; IP = datagram source address
    "host": "alice",
    "created": 1760467100000,
    "exp": 1760469000000  // optional: ephemeral room expiry (unix ms)
  }]
}
```

| Kind       | When                                    | Receiver action                                    |
|------------|-----------------------------------------|----------------------------------------------------|
| `announce` | every 2 s, and immediately on change    | upsert rooms; drop this node's rooms not listed    |
| `query`    | on startup, `/rooms`, Tab, Ctrl+R       | hosts re-announce after 0–150 ms random jitter     |
| `bye`      | graceful shutdown                       | forget the node and its rooms immediately          |

Entries expire 7 s after the last beacon, so crashed hosts disappear on their
own. The host address is deliberately not in the payload: the source IP of
the datagram is always reachable from the receiver, even on multi-homed hosts.

---

## 2. Control channel (TCP)

Every frame is `[u32 length][JSON]` where the JSON is an Envelope:

```json
{ "t": "<type>", "d": { /* payload */ } }
```

Frames above 1 MiB close the connection. Text bodies are capped at 64 KiB.

### 2.1 Handshake

```
client                                   hub
  │ ─────────────── TCP connect ───────────▶ │
  │ ◀── challenge {v, room, nonce, locked} ── │
  │ ── hello {v, node, nick, proof?,      ──▶ │  proof = HMAC-SHA256(passcode, nonce)
  │           ctrlPort, filePort}             │
  │ ◀── welcome {you, room, members,       ── │  or: reject {code, reason} + close
  │              successors, history}         │
  │ ◀── msg {… "bob joined"} ──────────────── │  (broadcast to everyone)
  │ ◀── members {members, successors} ─────── │  (broadcast to everyone)
```

* **Passcodes never cross the wire.** The hub sends a fresh 128-bit nonce and
  the client proves knowledge with an HMAC, which is compared in constant time.
* `room` in the challenge lets the client detect that a *different* room now
  occupies an address it remembered. It then aborts with `reject.code = "room"`.
* A node that isn't hosting answers any connection with
  `reject {code: "room"}` instead of a challenge.
* `reject.code` is one of `version | passcode | room | full | protocol`.
* `hello.ctrlPort` and `hello.filePort` are published in the roster.
  `ctrlPort` is where that member would host after a handover; `filePort`
  is where it serves files.

### 2.2 Steady state

| Type          | Dir | Payload                                    | Notes                                          |
|---------------|-----|--------------------------------------------|------------------------------------------------|
| `msg`         | ⇄   | `ChatMessage`                              | the hub overwrites `from`, `nick` and `ts`     |
| `members`     | ←   | `{members: Member[], successors: string[]}`| sent on every join, leave and rename           |
| `nick`        | →   | `{nick}`                                   | hub resolves collisions and broadcasts         |
| `ping`/`pong` | →/← | `{ts}`                                     | every 3 s; no pong within 10 s means dead       |
| `leave`       | →   | `{}`                                       | graceful exit ("left" vs "lost connection")    |
| `room_closed` | ←   | `{reason, handover?: Member}`              | room ends, or moves to `handover`              |

```jsonc
// ChatMessage
{
  "id": "9f2c41aa07be-17",  // <node>-<seq>: unique, used for dedupe and acks
  "from": "9f2c41aa07be",   // node id, or "hub" for system messages
  "nick": "alice",
  "kind": "chat",           // chat | me | dm | file | system
  "text": "hello",
  "to": "…",                // dm / directed file offer: target node id
  "file": { "xfer": "3d79d23d", "name": "map.zip", "size": 1048576,
            "sha256": "49bc…", "token": "<128-bit capability>" },
  "ts": 1760467200123       // hub-stamped: a single total order per room
}
```

**Delivery and acknowledgement.** The hub echoes every accepted message back
to its sender, and that echo is the ack. Until it arrives, the client keeps
the message in its **outbox** and shows it as `(sending…)`. After any
reconnect or handover, the outbox is resent. The hub dedupes by `id` and
re-acks duplicates, so the effect is exactly-once delivery from the user's
point of view.

**DMs** (`kind: "dm"`, `to` set) go only to the target and the sender. If
the target is temporarily disconnected, the hub stores the message in a
per-node **mailbox** (up to 100 messages) and delivers it right after that
node's next `welcome`.

### 2.3 Host handover

The hub publishes `successors`: every member except the host, in join
order. Every member therefore holds the same answer to "who hosts next?",
and no election round is needed.

```
Graceful (/leave, quit):
  hub ── room_closed {reason, handover: <successors[0]>} ──▶ all, then closes
  successor:  starts a Hub with the same RoomState + history, joins via loopback
  others:     dial handover.ip:handover.ctrlPort (up to 12 tries, 500 ms apart)

Abrupt (crash, cable pulled, no pong for 10 s):
  every member: retry old host ×2  →  walk successors in order
                 if the next candidate is *me*  → take over (start Hub)
                 else                           → dial it (×10, 500 ms apart)
```

The new hub keeps the room `id`, `name`, `locked`, `created` and `exp`. Its
discovery beacon replaces the old one, because entries are keyed by room id.

---

## 3. File channel (TCP)

Transfers use a pull model and never pass through the hub.

1. The sender hashes the file (SHA-256, streamed) and registers a *share*
   `{xfer, path, token, to?}`. It then posts a `msg` with `kind: "file"`.
2. A recipient who accepts dials the **sender's** `ip:filePort` directly:

```
recv ── [u32][{"t":"get","d":{"xfer","token","node","offset"}}] ──▶ sender
recv ◀── [u32][{"t":"meta","d":{"size","sha256","offset"}}] ─────── sender
          or [u32][{"t":"err","d":{"reason"}}] and close
recv ◀── [u32 = 65536][64 KiB of bytes] ─────────────────────────── sender
recv ◀── … ──────────────────────────────────────────────────────── sender
recv ◀── [u32 = 0]                         (end of stream) ───────── sender
```

* `token` is a 128-bit capability, compared in constant time. Directed offers
  (`/send … @bob`) also check that `get.node` matches the intended recipient.
* **Integrity.** The receiver hashes while writing `.<xfer>-<name>.part`. It
  checks `meta` against the offer, rejects any byte beyond `size`, and
  compares the final digest before atomically renaming the file into place.
  On a mismatch the partial file is deleted.
* **Resume.** `offset` is the length of an existing `.part` file. The
  receiver re-hashes that prefix locally, and the sender streams from
  `offset`.
* **Backpressure** is honoured on both sides: the sender waits for `drain`,
  and the receiver pauses the socket while the disk catches up. So memory
  stays flat for any file size, and a big transfer never delays chat.
* Filenames from the network are reduced to a safe basename: no path
  separators, no control characters, no leading dots.

---

## Versioning

`v` appears in beacons, challenges and hellos. Peers drop beacons with a
different `v`, and hubs reject hellos with `reject.code = "version"`. Fields
may be added in a compatible way, because unknown fields are ignored.
