import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { hashFile, randomId } from '../protocol/crypto.js';
import { FrameDecoder, frame, jsonFrame, parseEnvelope } from '../protocol/framing.js';
import { CHUNK_SIZE, type FileFrames, type FileOffer, type Get, type Meta } from '../protocol/types.js';
import type { Store, Transfer } from '../store/Store.js';
import type { Listener, Stream, TransportAdapter } from '../transport/types.js';

interface Share {
  offer: FileOffer;
  path: string;
  to?: string; // restrict to one node (direct send)
}

export interface TransferDeps {
  transport: TransportAdapter;
  store: Store;
  node: string;
  downloadDir: string;
  nickOf: (node: string) => string;
}

const PROGRESS_EVERY_MS = 150;

/**
 * Peer-to-peer file transfer on a dedicated TCP listener, fully separate
 * from the chat connection so a 4 GB upload never delays a message.
 *
 * Pull model: the sender hashes the file, registers a share with a random
 * capability token and posts a FileOffer in chat. Each recipient that
 * accepts dials the *sender* directly and pulls the bytes, verifying
 * SHA-256 on the fly. Partial downloads are kept as `.part` files and
 * resumed from their current length on retry.
 */
export class TransferService {
  private shares = new Map<string, Share>();
  private active = new Map<string, (reason: string) => void>(); // transfer id → abort
  private listener: Listener | null = null;

  constructor(private readonly deps: TransferDeps) {}

  async start(port: number): Promise<number> {
    this.listener = await this.deps.transport.listen(port, (s) => this.serve(s));
    return this.listener.port;
  }

  async stop(): Promise<void> {
    for (const abort of this.active.values()) abort('shutting down');
    await this.listener?.close();
  }

  // ── sending ──

  /** Hash a file and register it for download. Returns the offer to post. */
  async share(path: string, opts: { to?: string; peerLabel: string }): Promise<FileOffer> {
    const st = await stat(path);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    const xfer = randomId(4);
    const name = safeName(basename(path));
    const t: Transfer = {
      id: xfer,
      xfer,
      direction: 'up',
      name,
      size: st.size,
      bytes: 0,
      peer: opts.peerLabel,
      peerNode: opts.to,
      state: 'hashing',
      speed: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      path,
    };
    this.deps.store.upsertTransfer(t);
    const ac = new AbortController();
    this.active.set(xfer, () => ac.abort());
    try {
      const progress = this.progress(xfer, 0);
      const hash = await hashFile(path, { onProgress: progress.tick, signal: ac.signal });
      progress.flush(st.size);
      const offer: FileOffer = { xfer, name, size: st.size, sha256: hash.digest('hex'), token: randomId(16) };
      this.shares.set(xfer, { offer, path, to: opts.to });
      this.deps.store.patchTransfer(xfer, { state: 'waiting', bytes: 0, speed: 0, finishedAt: Date.now() });
      return offer;
    } catch (err) {
      this.deps.store.patchTransfer(xfer, {
        state: ac.signal.aborted ? 'cancelled' : 'failed',
        error: (err as Error).message,
        finishedAt: Date.now(),
      });
      throw err;
    } finally {
      this.active.delete(xfer);
    }
  }

  private serve(stream: Stream): void {
    const decoder = new FrameDecoder(64 * 1024);
    let handled = false;
    stream.on('error', () => {});
    const timer = setTimeout(() => stream.destroy(), 10_000);
    const onData = (chunk: Buffer) => {
      let frames: Buffer[];
      try {
        frames = decoder.push(chunk);
      } catch {
        stream.destroy();
        return;
      }
      if (!frames.length || handled) return;
      handled = true;
      clearTimeout(timer);
      stream.off('data', onData);
      let env;
      try {
        env = parseEnvelope(frames[0]);
      } catch {
        stream.destroy();
        return;
      }
      if (env.t !== 'get') return void stream.destroy();
      this.upload(stream, env.d as Get).catch(() => stream.destroy());
    };
    stream.on('data', onData);
  }

  private async upload(stream: Stream, get: Get): Promise<void> {
    const fail = (reason: string) => {
      stream.end(jsonFrame('err', { reason } satisfies FileFrames['err']));
    };
    const share = this.shares.get(get?.xfer);
    if (!share || !tokenEquals(share.offer.token, get.token)) return fail('unknown or expired transfer');
    if (share.to && share.to !== get.node) return fail('this file was offered to someone else');
    const offset = Number.isSafeInteger(get.offset) && get.offset >= 0 ? get.offset : 0;
    const { offer } = share;
    if (offset > offer.size) return fail('bad offset');
    const st = await stat(share.path).catch(() => null);
    if (!st || st.size !== offer.size) return fail('file changed or was removed on the sender');

    stream.write(jsonFrame('meta', { size: offer.size, sha256: offer.sha256, offset } satisfies Meta));

    const id = `${offer.xfer}>${get.node}`;
    this.deps.store.upsertTransfer({
      id,
      xfer: offer.xfer,
      direction: 'up',
      name: offer.name,
      size: offer.size,
      bytes: offset,
      peer: this.deps.nickOf(get.node),
      peerNode: get.node,
      state: 'active',
      speed: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      path: share.path,
      resumedFrom: offset || undefined,
    });
    let aborted: string | null = null;
    this.active.set(id, (reason) => {
      aborted = reason;
      stream.destroy();
    });
    const progress = this.progress(id, offset);
    let sent = offset;
    try {
      const rs = createReadStream(share.path, { start: offset, highWaterMark: CHUNK_SIZE });
      for await (const chunk of rs as AsyncIterable<Buffer>) {
        if (stream.destroyed) throw new Error(aborted ?? 'receiver disconnected');
        sent += chunk.length;
        if (!stream.write(frame(chunk))) await drained(stream);
        progress.tick(sent);
      }
      stream.end(frame(Buffer.alloc(0)));
      progress.flush(sent);
      this.deps.store.patchTransfer(id, { state: 'done', finishedAt: Date.now() });
    } catch (err) {
      progress.flush(sent);
      this.deps.store.patchTransfer(id, {
        state: aborted === 'cancelled' ? 'cancelled' : 'failed',
        error: aborted ?? (err as Error).message,
        finishedAt: Date.now(),
      });
      stream.destroy();
    } finally {
      this.active.delete(id);
    }
  }

  // ── receiving ──

  /** Record an incoming offer (no bytes move until accepted). */
  registerOffer(offer: FileOffer, from: { node: string; nick: string }): Transfer | null {
    if (!validOffer(offer)) return null;
    if (this.deps.store.getTransfer(offer.xfer)) return null; // already known (history replay)
    const t: Transfer = {
      id: offer.xfer,
      xfer: offer.xfer,
      direction: 'down',
      name: safeName(offer.name),
      size: offer.size,
      bytes: 0,
      peer: from.nick,
      peerNode: from.node,
      state: 'offered',
      speed: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      offer,
    };
    this.deps.store.upsertTransfer(t);
    return t;
  }

  /** Fetch an offered file from its sender. Resolves when finished (or failed). */
  async download(id: string, host: string, port: number): Promise<void> {
    const t = this.deps.store.getTransfer(id);
    if (!t?.offer) throw new Error(`no incoming transfer ${id}`);
    if (this.active.has(id)) throw new Error(`${t.name} is already downloading`);
    const { offer } = t;
    const dir = this.deps.downloadDir;
    await mkdir(dir, { recursive: true });
    const part = join(dir, `.${offer.xfer}-${t.name}.part`);

    let offset = (await stat(part).catch(() => null))?.size ?? 0;
    if (offset > offer.size) {
      await rm(part, { force: true });
      offset = 0;
    }
    this.deps.store.patchTransfer(id, {
      state: 'active',
      bytes: offset,
      speed: 0,
      error: undefined,
      startedAt: Date.now(),
      resumedFrom: offset || undefined,
      finishedAt: undefined,
    });

    let reason: string | null = null;
    let stream: Stream | null = null;
    const ac = new AbortController();
    this.active.set(id, (r) => {
      reason = r;
      ac.abort();
      stream?.destroy();
    });
    const progress = this.progress(id, offset);
    try {
      const hash = offset ? await hashFile(part, { limit: offset, signal: ac.signal }) : createHash('sha256');
      stream = await this.deps.transport.dial(host, port);
      if (reason) throw new Error(reason);
      await this.receive(stream, { offer, offset, part, hash, onBytes: progress.tick, signal: ac.signal });
      progress.flush(offer.size);
      this.deps.store.patchTransfer(id, { state: 'verifying', speed: 0 });
      const digest = hash.digest('hex');
      if (digest !== offer.sha256) {
        await rm(part, { force: true });
        throw new Error(`checksum mismatch (got ${digest.slice(0, 12)}…, expected ${offer.sha256.slice(0, 12)}…)`);
      }
      const finalPath = await uniquePath(dir, t.name);
      await rename(part, finalPath);
      this.deps.store.patchTransfer(id, { state: 'done', path: finalPath, finishedAt: Date.now() });
    } catch (err) {
      if (reason === 'cancelled') await rm(part, { force: true });
      this.deps.store.patchTransfer(id, {
        state: reason === 'cancelled' ? 'cancelled' : 'failed',
        error: reason ?? (err as Error).message,
        speed: 0,
        finishedAt: Date.now(),
      });
      throw err;
    } finally {
      this.active.delete(id);
      stream?.destroy();
    }
  }

  private receive(
    stream: Stream,
    o: {
      offer: FileOffer;
      offset: number;
      part: string;
      hash: ReturnType<typeof createHash>;
      onBytes: (n: number) => void;
      signal: AbortSignal;
    },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const decoder = new FrameDecoder(CHUNK_SIZE * 2);
      let meta: Meta | null = null;
      let ws: WriteStream | null = null;
      let bytes = o.offset;
      let settled = false;
      let paused = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        if (ws) ws.end(() => reject(err));
        else reject(err);
      };
      o.signal.addEventListener('abort', () => fail(new Error('cancelled')), { once: true });

      stream.write(jsonFrame('get', { xfer: o.offer.xfer, token: o.offer.token, node: this.deps.node, offset: o.offset } satisfies Get));
      stream.on('error', (e) => fail(e));
      stream.on('close', () => fail(new Error('sender disconnected mid-transfer')));
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        let frames: Buffer[];
        try {
          frames = decoder.push(chunk);
        } catch (e) {
          return fail(e as Error);
        }
        for (const f of frames) {
          if (settled) return;
          if (!meta) {
            let env;
            try {
              env = parseEnvelope(f);
            } catch (e) {
              return fail(e as Error);
            }
            if (env.t === 'err') return fail(new Error((env.d as { reason: string }).reason));
            if (env.t !== 'meta') return fail(new Error('protocol error'));
            meta = env.d as Meta;
            if (meta.size !== o.offer.size || meta.sha256 !== o.offer.sha256 || meta.offset !== o.offset) {
              return fail(new Error('sender metadata does not match offer'));
            }
            ws = createWriteStream(o.part, { flags: o.offset ? 'a' : 'w' });
            ws.on('error', (e) => fail(e));
            continue;
          }
          if (f.length === 0) {
            if (bytes !== o.offer.size) return fail(new Error(`short transfer (${bytes}/${o.offer.size} bytes)`));
            settled = true;
            ws!.end(() => resolve());
            stream.destroy();
            return;
          }
          bytes += f.length;
          if (bytes > o.offer.size) return fail(new Error('sender sent more data than offered'));
          o.hash.update(f);
          o.onBytes(bytes);
          if (!ws!.write(f) && !paused) {
            paused = true;
            stream.pause();
            ws!.once('drain', () => {
              paused = false;
              stream.resume();
            });
          }
        }
      });
    });
  }

  /** Mark an incoming offer as rejected. */
  reject(id: string): boolean {
    const t = this.deps.store.getTransfer(id);
    if (!t || t.state !== 'offered') return false;
    this.deps.store.patchTransfer(id, { state: 'rejected', finishedAt: Date.now() });
    return true;
  }

  /** Abort a running transfer; for an outgoing offer, also withdraw the share. */
  cancel(id: string): boolean {
    let hit = false;
    for (const [tid, abort] of this.active) {
      if (tid === id || tid.startsWith(`${id}>`)) {
        abort('cancelled');
        hit = true;
      }
    }
    if (this.shares.delete(id)) {
      this.deps.store.patchTransfer(id, { state: 'cancelled', finishedAt: Date.now() });
      hit = true;
    }
    return hit;
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  /** Throttled progress reporter with smoothed speed. */
  private progress(id: string, start: number) {
    let lastBytes = start;
    let lastAt = Date.now();
    let speed = 0;
    let latest = start;
    const flush = (bytes = latest) => {
      const now = Date.now();
      const dt = (now - lastAt) / 1000;
      if (dt > 0) {
        const inst = (bytes - lastBytes) / dt;
        speed = speed ? speed * 0.7 + inst * 0.3 : inst;
      }
      lastBytes = bytes;
      lastAt = now;
      this.deps.store.patchTransfer(id, { bytes, speed });
    };
    return {
      tick: (bytes: number) => {
        latest = bytes;
        if (Date.now() - lastAt >= PROGRESS_EVERY_MS) flush(bytes);
      },
      flush,
    };
  }
}

function drained(stream: Stream): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      stream.off('drain', onDrain);
      stream.off('close', onClose);
      err ? reject(err) : resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error('receiver disconnected'));
    stream.once('drain', onDrain);
    stream.once('close', onClose);
  });
}

function tokenEquals(a: string, b: unknown): boolean {
  if (typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function validOffer(o: FileOffer | undefined): o is FileOffer {
  return (
    !!o &&
    typeof o.xfer === 'string' &&
    /^[0-9a-f]{4,32}$/.test(o.xfer) &&
    typeof o.name === 'string' &&
    Number.isSafeInteger(o.size) &&
    o.size >= 0 &&
    typeof o.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(o.sha256) &&
    typeof o.token === 'string'
  );
}

/** Never trust a remote filename: no paths, no control chars, no dotfiles. */
export function safeName(name: string): string {
  const cleaned = basename(String(name).replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180);
  return cleaned || 'file';
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = join(dir, i ? `${stem} (${i})${ext}` : name);
    if (!(await stat(candidate).catch(() => null))) return candidate;
  }
}
