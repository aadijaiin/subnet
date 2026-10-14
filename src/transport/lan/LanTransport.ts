import net from 'node:net';
import type { Discovery, Listener, Stream, TransportAdapter } from '../types.js';
import { LanDiscovery, type LanDiscoveryOptions } from './discovery.js';
import { explainDialError } from './net-errors.js';
import { primaryIPv4 } from './net-utils.js';

export interface LanTransportOptions {
  /** Disable UDP discovery (e.g. on a VPN/overlay where broadcast doesn't cross). */
  discovery?: boolean | LanDiscoveryOptions;
  /** Bind address for TCP listeners. */
  bindHost?: string;
}

/**
 * Plain TCP + UDP discovery. Also the right adapter for overlay networks
 * like Tailscale or WireGuard with `discovery: false`: TCP works across them
 * unchanged, and rooms are joined with `/connect <ip:port>`.
 */
export class LanTransport implements TransportAdapter {
  readonly name: string;
  readonly discovery: Discovery | null;
  private readonly bindHost: string;

  constructor(opts: LanTransportOptions = {}) {
    const d = opts.discovery ?? true;
    this.discovery = d ? new LanDiscovery(typeof d === 'object' ? d : {}) : null;
    this.name = d ? 'lan' : 'direct';
    this.bindHost = opts.bindHost ?? '0.0.0.0';
  }

  listen(port: number, onStream: (s: Stream) => void): Promise<Listener> {
    return new Promise((resolve, reject) => {
      const sockets = new Set<net.Socket>();
      const server = net.createServer({ noDelay: true, keepAlive: true, keepAliveInitialDelay: 10_000 }, (sock) => {
        sockets.add(sock);
        sock.on('error', () => {});
        sock.once('close', () => sockets.delete(sock));
        onStream(sock);
      });
      server.once('error', reject);
      server.listen(port, this.bindHost, () => {
        server.off('error', reject);
        server.on('error', () => {});
        const addr = server.address() as net.AddressInfo;
        resolve({
          port: addr.port,
          // server.close() waits for every open connection; end them ourselves.
          close: () =>
            new Promise<void>((r) => {
              server.close(() => r());
              for (const s of sockets) s.destroy();
            }),
        });
      });
    });
  }

  dial(host: string, port: number, timeoutMs = 4000): Promise<Stream> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port, noDelay: true, keepAlive: true, keepAliveInitialDelay: 10_000 });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(explainDialError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), host, port, timeoutMs));
      }, timeoutMs);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.removeAllListeners('error');
        sock.on('error', () => {}); // consumers attach their own; never crash on a late reset
        resolve(sock);
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(explainDialError(err, host, port, timeoutMs));
      });
    });
  }

  localAddress(): string {
    return primaryIPv4();
  }
}
