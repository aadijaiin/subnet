import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Engine, JoinError } from '../src/engine/Engine.js';
import { LanTransport } from '../src/transport/lan/LanTransport.js';

// A private discovery port so tests never see (or disturb) real instances.
const PORT = 47000 + Math.floor(Math.random() * 900);

async function waitFor<T>(fn: () => T | undefined | false, label: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function makeEngine(nick: string): Promise<Engine> {
  const dir = await mkdtemp(join(tmpdir(), `subnet-${nick}-`));
  const e = new Engine({
    nick,
    downloadDir: dir,
    transport: new LanTransport({ discovery: { port: PORT, intervalMs: 300, ttlMs: 2000 } }),
  });
  await e.start();
  return e;
}

const texts = (e: Engine) => e.store.get().room?.messages.map((m) => m.text) ?? [];

describe('subnet engine (real sockets)', () => {
  let a: Engine, b: Engine, c: Engine;

  before(async () => {
    [a, b, c] = await Promise.all([makeEngine('alice'), makeEngine('alice'), makeEngine('carol')]);
  });
  after(async () => {
    await Promise.all([a, b, c].map((e) => e.stop()));
  });

  it('discovers a hosted room over UDP', async () => {
    await a.host('lobby');
    const room = await waitFor(() => b.store.get().rooms.find((r) => r.name === 'lobby' && r.members === 1), 'b sees lobby');
    assert.equal(room.members, 1);
    assert.equal(room.host, 'alice');
  });

  it('assigns collision-free nicknames', async () => {
    await b.join('lobby');
    assert.equal(b.nick, 'alice-2');
    await waitFor(() => a.store.get().room?.members.length === 2, 'a sees 2 members');
  });

  it('delivers chat in real time and acks the outbox', async () => {
    b.say('hello from b');
    await waitFor(() => texts(a).includes('hello from b'), 'a receives');
    await waitFor(() => b.store.get().room?.messages.find((m) => m.text === 'hello from b' && !m.pending), 'b ack');
  });

  it('delivers DMs only to the target', async () => {
    await c.join('lobby');
    await waitFor(() => a.store.get().room?.members.some((m) => m.nick === 'carol'), 'a sees carol');
    a.dm('carol', 'psst');
    await waitFor(() => texts(c).includes('psst'), 'carol gets dm');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!texts(b).includes('psst'), 'b must not see the dm');
  });

  it('transfers a file peer-to-peer with SHA-256 verification', async () => {
    const data = randomBytes(3 * 1024 * 1024 + 123);
    const src = join(await mkdtemp(join(tmpdir(), 'subnet-src-')), 'payload.bin');
    await writeFile(src, data);
    await a.sendFile(src);
    const offer = await waitFor(() => b.store.get().transfers.find((t) => t.direction === 'down' && t.state === 'offered'), 'b offered');
    const saved = await b.accept(offer.xfer);
    const got = await readFile(saved);
    assert.equal(createHash('sha256').update(got).digest('hex'), createHash('sha256').update(data).digest('hex'));
    assert.equal(b.store.getTransfer(offer.xfer)?.state, 'done');
  });

  it('hands the room to the longest-standing member when the host leaves', async () => {
    a.leave();
    await waitFor(() => b.store.get().room?.hosting && b.store.get().room?.status === 'connected', 'b becomes host');
    await waitFor(() => c.store.get().room?.status === 'connected' && c.store.get().room?.members.length === 2, 'c reconnects to b');
    c.say('still here');
    await waitFor(() => texts(b).includes('still here'), 'b gets message after handover');
    // History survived the handover.
    assert.ok(texts(c).includes('hello from b'));
  });

  it('survives an abrupt host crash and queues messages typed meanwhile', async () => {
    // Simulate a crash: kill b's hub and sockets without any goodbye.
    const bb = b as unknown as {
      hub: { peers: Map<string, { conn: { destroy(): void } }> } | null;
      client: { destroy(): void } | null;
      ctrl: { close(): Promise<void> };
    };
    const hub = bb.hub!;
    bb.hub = null;
    await bb.ctrl.close();
    for (const p of hub.peers.values()) p.conn.destroy();
    await waitFor(() => c.store.get().room?.status === 'reconnecting', 'c notices loss', 12_000);
    c.say('typed while offline');
    await waitFor(() => c.store.get().room?.hosting && c.store.get().room?.status === 'connected', 'c takes over', 20_000);
    await waitFor(() => c.store.get().room?.messages.find((m) => m.text === 'typed while offline' && !m.pending), 'outbox flushed', 5000);
  });

  it('enforces passcodes without sending them over the wire', async () => {
    a.leave(true);
    await a.host('secret', { passcode: 'hunter2' });
    await waitFor(() => b.store.get().rooms.find((r) => r.name === 'secret'), 'b sees secret');
    await assert.rejects(b.join('secret'), (e: unknown) => e instanceof JoinError && e.code === 'passcode-required');
    await assert.rejects(b.join('secret', 'wrong'), (e: unknown) => e instanceof JoinError && e.code === 'passcode');
    await b.join('secret', 'hunter2');
    assert.equal(b.store.get().room?.state.name, 'secret');
  });

  it('never drops a frame that arrives in the same segment as welcome', async () => {
    // The hub sends "<nick> joined" right behind welcome; it must reach the joiner.
    await waitFor(() => b.store.get().room?.messages.some((m) => m.text === 'alice-2 joined'), 'own join notice');
  });

  it('queues DMs for a peer who dropped and delivers them on reconnect', async () => {
    const bNode = b.node;
    await waitFor(() => a.store.get().room?.members.some((m) => m.node === bNode), 'a sees b');
    const room = a.store.get().room!;
    // Drop b's connection without auto-recovery, DM it while away, then let it come back.
    const internals = b as unknown as { client: { destroy(): void }; recover(): Promise<void> };
    internals.client.destroy();
    await waitFor(() => !a.store.get().room?.members.some((m) => m.node === bNode), 'hub notices b left');
    a.dm('alice-2', 'while you were out');
    await waitFor(() => texts(a).some((t) => t?.includes('offline')), 'sender told it was queued');
    void internals.recover();
    await waitFor(
      () => b.store.get().room?.status === 'connected' && texts(b).includes('while you were out'),
      'queued dm delivered',
      10_000,
    );
    assert.equal(room.state.id, b.store.get().room?.state.id);
  });

  it('resumes a partial download from where it stopped', async () => {
    const data = randomBytes(2 * 1024 * 1024);
    const src = join(await mkdtemp(join(tmpdir(), 'subnet-src-')), 'resume.bin');
    await writeFile(src, data);
    await a.sendFile(src);
    const offer = await waitFor(() => b.store.get().transfers.find((t) => t.name === 'resume.bin' && t.state === 'offered'), 'offer');
    // Pretend an earlier attempt got the first 700 KB.
    const part = join(b.store.get().self.downloadDir, `.${offer.xfer}-resume.bin.part`);
    await writeFile(part, data.subarray(0, 700 * 1024));
    const saved = await b.accept(offer.xfer);
    assert.deepEqual(await readFile(saved), data);
    assert.equal(b.store.getTransfer(offer.xfer)?.resumedFrom, 700 * 1024);
  });

  it('auto-destructs ephemeral rooms', async () => {
    a.leave(true);
    await a.host('flash', { ttlMs: 800 });
    await waitFor(() => !a.store.get().room, 'room expires', 5000);
    assert.ok(a.store.get().lobby.some((m) => m.text?.includes('expired')));
  });
});
