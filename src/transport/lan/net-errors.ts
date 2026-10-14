/**
 * Turn raw socket errors into something a person can act on. "connect
 * EHOSTUNREACH" is accurate but useless; the likely causes on a home or
 * office LAN are few and well known.
 */
export function explainDialError(err: NodeJS.ErrnoException, host: string, port: number, timeoutMs: number): Error {
  const where = `${host}:${port}`;
  let message: string;
  switch (err.code) {
    case 'EHOSTUNREACH':
    case 'EHOSTDOWN':
    case 'ENETUNREACH':
      message =
        `can't reach ${host} directly (no route to host). If the room showed up in your list, broadcasts get through but ` +
        `device-to-device traffic is blocked — almost always Wi-Fi client/AP isolation (guest networks, many routers). ` +
        `Fix: turn off AP isolation, use the main (non-guest) Wi-Fi or a phone hotspot, or use Tailscale with --no-discovery + /connect.`;
      break;
    case 'ECONNREFUSED':
      message = `${where} refused the connection — that room has probably closed. Ctrl+R refreshes the room list.`;
      break;
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      message =
        `${where} didn't answer within ${Math.round(timeoutMs / 1000)}s. Either a firewall on ${host} is dropping connections ` +
        `(macOS: System Settings › Network › Firewall must allow node; Linux: e.g. sudo ufw allow from 192.168.0.0/16), ` +
        `or the Wi-Fi blocks device-to-device traffic (client/AP isolation — try the main Wi-Fi or a phone hotspot).`;
      break;
    case 'ENETDOWN':
      message = `your network interface is down — check your Wi-Fi/Ethernet connection.`;
      break;
    default:
      return err;
  }
  return Object.assign(new Error(message), { code: err.code, cause: err });
}
