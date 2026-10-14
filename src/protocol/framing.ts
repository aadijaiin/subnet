import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { MAX_FRAME, type ControlFrames, type ControlType, type Envelope } from './types.js';

/** Encode one length-prefixed frame. */
export function frame(payload: Buffer): Buffer {
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(payload.length, 0);
  return payload.length === 0 ? head : Buffer.concat([head, payload]);
}

export function jsonFrame(t: string, d?: unknown): Buffer {
  return frame(Buffer.from(JSON.stringify(d === undefined ? { t } : { t, d })));
}

/**
 * Incremental decoder for [u32 length][payload] frames. Works for both JSON
 * control frames and raw file chunks; the caller decides how to interpret
 * each payload.
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(private readonly maxFrame = MAX_FRAME) {}

  /** Feed bytes; returns every complete payload now available. */
  push(data: Buffer): Buffer[] {
    this.chunks.push(data);
    this.buffered += data.length;
    const out: Buffer[] = [];
    for (;;) {
      if (this.buffered < 4) break;
      const head = this.peek(4);
      const len = head.readUInt32BE(0);
      if (len > this.maxFrame) throw new Error(`frame too large (${len} bytes)`);
      if (this.buffered < 4 + len) break;
      this.take(4);
      out.push(this.take(len));
    }
    return out;
  }

  private peek(n: number): Buffer {
    if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
    const merged = Buffer.concat(this.chunks);
    this.chunks = [merged];
    return merged.subarray(0, n);
  }

  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    let first = this.chunks[0];
    if (first.length < n) {
      first = Buffer.concat(this.chunks);
      this.chunks = [first];
    }
    const out = first.subarray(0, n);
    if (first.length === n) this.chunks.shift();
    else this.chunks[0] = first.subarray(n);
    this.buffered -= n;
    return out;
  }
}

export function parseEnvelope(payload: Buffer): Envelope {
  const env = JSON.parse(payload.toString('utf8')) as Envelope;
  if (!env || typeof env.t !== 'string') throw new Error('malformed envelope');
  return env;
}

type FrameHandler = <T extends ControlType>(t: T, d: ControlFrames[T]) => void;

/**
 * A typed, message-oriented wrapper around any Duplex stream (TCP socket,
 * TLS socket, tunnel stream…). Emits `frame` and `close` exactly once.
 */
export class ControlConnection extends EventEmitter {
  private decoder = new FrameDecoder();
  private closed = false;
  readonly remoteAddress: string;

  constructor(readonly stream: Duplex & { remoteAddress?: string; setNoDelay?: (v: boolean) => unknown }) {
    super();
    this.remoteAddress = normalizeIP(stream.remoteAddress ?? '');
    stream.setNoDelay?.(true);
    stream.on('data', (chunk: Buffer) => {
      let payloads: Buffer[];
      try {
        payloads = this.decoder.push(chunk);
      } catch (err) {
        this.destroy(err as Error);
        return;
      }
      for (const p of payloads) {
        if (this.closed) return;
        let env: Envelope;
        try {
          env = parseEnvelope(p);
        } catch (err) {
          this.destroy(err as Error);
          return;
        }
        this.emit('frame', env.t, env.d);
      }
    });
    stream.on('error', (err) => this.finish(err));
    stream.on('close', () => this.finish());
    stream.on('end', () => stream.end());
  }

  onFrame(handler: FrameHandler): this {
    return this.on('frame', handler as (...a: unknown[]) => void);
  }

  /** Resolve with the next frame of one of the given types (or reject on close/timeout). */
  next<T extends ControlType>(types: T[], timeoutMs: number): Promise<{ t: T; d: ControlFrames[T] }> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('frame', onFrame);
        this.off('close', onClose);
      };
      const onFrame = (t: string, d: unknown) => {
        if (!(types as string[]).includes(t)) return;
        cleanup();
        resolve({ t: t as T, d: d as ControlFrames[T] });
      };
      const onClose = (err?: Error) => {
        cleanup();
        reject(err ?? new Error('connection closed'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${types.join('/')}`));
      }, timeoutMs);
      this.on('frame', onFrame);
      this.once('close', onClose);
    });
  }

  send<T extends ControlType>(t: T, d?: ControlFrames[T]): boolean {
    if (this.closed || this.stream.destroyed) return false;
    return this.stream.write(jsonFrame(t, d));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Flush pending writes, then close. */
  end(): void {
    if (this.closed) return;
    this.stream.end();
    setTimeout(() => this.stream.destroy(), 1000).unref();
  }

  destroy(err?: Error): void {
    this.stream.destroy();
    this.finish(err);
  }

  private finish(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', err);
  }
}

export function normalizeIP(addr: string): string {
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export function isLoopback(ip: string): boolean {
  return ip.startsWith('127.') || ip === '::1' || ip === '';
}
