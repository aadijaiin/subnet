import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function randomId(bytes = 6): string {
  return randomBytes(bytes).toString('hex');
}

/** Passcode challenge response. The passcode itself never crosses the network. */
export function proof(passcode: string, nonce: string): string {
  return createHmac('sha256', passcode).update(nonce).digest('hex');
}

export function verifyProof(passcode: string, nonce: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const want = Buffer.from(proof(passcode, nonce), 'hex');
  const got = Buffer.from(candidate, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Stream a file (or its first `limit` bytes) through SHA-256 without loading
 * it into memory. Returns the live hash object so callers can keep updating
 * it (used when resuming a partial download).
 */
export async function hashFile(path: string, opts: { limit?: number; onProgress?: (bytes: number) => void; signal?: AbortSignal } = {}) {
  const hash = createHash('sha256');
  if (opts.limit === 0) return hash;
  const stream = createReadStream(path, {
    highWaterMark: 1 << 20,
    end: opts.limit !== undefined ? opts.limit - 1 : undefined,
    signal: opts.signal,
  });
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
    opts.onProgress?.(bytes);
  }
  return hash;
}
