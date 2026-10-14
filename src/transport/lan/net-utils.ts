import { networkInterfaces } from 'node:os';

export interface V4Interface {
  name: string;
  address: string;
  netmask: string;
  broadcast: string;
}

/** Non-internal IPv4 interfaces that are up. */
export function ipv4Interfaces(): V4Interface[] {
  const out: V4Interface[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address, netmask: a.netmask, broadcast: directedBroadcast(a.address, a.netmask) });
    }
  }
  // Prefer physical LAN interfaces over VPN/bridge ones for "primary IP".
  const rank = (n: string) => (/^(en|eth|wl|wlan)/.test(n) ? 0 : /^(utun|tun|tap|tailscale|wg|docker|br-|veth|vbox|vmnet)/.test(n) ? 2 : 1);
  return out.sort((a, b) => rank(a.name) - rank(b.name));
}

export function directedBroadcast(address: string, netmask: string): string {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((octet, i) => (octet | (~m[i] & 0xff)) & 0xff).join('.');
}

export function primaryIPv4(): string {
  return ipv4Interfaces()[0]?.address ?? '127.0.0.1';
}
