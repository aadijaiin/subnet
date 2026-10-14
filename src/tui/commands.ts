import { Engine, JoinError } from '../engine/Engine.js';
import { readClipboard } from '../util/clipboard.js';
import { formatBytes, formatDuration, parseDuration } from '../util/format.js';

export interface CommandUI {
  openPicker(target?: string): void;
  focusRooms(): void;
  promptPasscode(ref: string, label: string, mode: 'join' | 'connect'): void;
  quit(): void;
}

export const HELP: [string, string][] = [
  ['/rooms', 'refresh and browse rooms on the LAN (or press Tab)'],
  ['/host <name> [-p pass] [-t 30m]', 'create a room; -t makes it ephemeral (auto-destructs)'],
  ['/join <#|name> [pass]', 'join a discovered room by list number or name'],
  ['/connect <ip:port> [pass]', 'join by address (VPN / Tailscale / no broadcast)'],
  ['/leave', 'leave the room (hosts hand over to the next member)'],
  ['/nick <name>', 'change nickname (collisions resolved automatically)'],
  ['/me <action>', 'emote'],
  ['/dm <nick> <text>', 'private message (queued if they are offline)'],
  ['/send [path] [@nick]', 'share a file with the room or one peer; no path opens the picker'],
  ['/accept [id]  /reject [id]', 'accept/reject an incoming file (default: latest)'],
  ['/cancel [id]', 'cancel a transfer or withdraw an offer'],
  ['/paste [@nick]', 'send clipboard contents as a message (or DM)'],
  ['/who', 'list members and succession order'],
  ['/clear', 'clear the feed'],
  ['/quit', 'exit (Ctrl+C)'],
];

/**
 * Split a command line into tokens, honouring "double", 'single' quotes and
 * backslash-escaped spaces (what macOS Terminal produces when you drag a file in).
 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Pull `-x value` flags out of a token list. */
function flags(tokens: string[], spec: Record<string, string>): { rest: string[]; f: Record<string, string> } {
  const rest: string[] = [];
  const f: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const name = spec[tokens[i]];
    if (name && i + 1 < tokens.length) f[name] = tokens[++i];
    else rest.push(tokens[i]);
  }
  return { rest, f };
}

export async function runInput(line: string, engine: Engine, ui: CommandUI): Promise<void> {
  const notice = (t: string, level?: 'info' | 'warn' | 'error') => engine.store.notice(t, level);
  try {
    if (!line.startsWith('/') || line.startsWith('//')) {
      engine.say(line.startsWith('//') ? line.slice(1) : line);
      return;
    }
    const sp = line.indexOf(' ');
    const cmd = (sp === -1 ? line : line.slice(0, sp)).toLowerCase();
    const argStr = sp === -1 ? '' : line.slice(sp + 1).trim();
    const args = tokenize(argStr);

    switch (cmd) {
      case '/help':
      case '/?':
        notice('Commands:');
        for (const [c, d] of HELP) notice(`  ${c.padEnd(34)} ${d}`);
        notice('Keys: Tab rooms · PgUp/PgDn scroll · ↑/↓ history · Ctrl+O file picker · Ctrl+R refresh · Ctrl+C quit');
        return;

      case '/rooms':
      case '/list':
        engine.refreshRooms();
        ui.focusRooms();
        return;

      case '/host':
      case '/create': {
        const { rest, f } = flags(args, { '-p': 'pass', '--pass': 'pass', '-t': 'ttl', '--ttl': 'ttl' });
        const name = rest.join(' ');
        if (!name) return notice('usage: /host <name> [-p passcode] [-t 30m]', 'warn');
        let ttlMs: number | undefined;
        if (f.ttl) {
          const ms = parseDuration(f.ttl);
          if (!ms) return notice(`couldn't parse duration "${f.ttl}" (try 30s, 10m, 2h)`, 'warn');
          ttlMs = ms;
        }
        await engine.host(name, { passcode: f.pass, ttlMs });
        notice(
          `Hosting "${name}"${f.pass ? ' (passcode-protected)' : ''}${ttlMs ? ` — self-destructs in ${formatDuration(ttlMs)}` : ''}. Peers on your LAN can see it now.`,
        );
        return;
      }

      case '/join':
      case '/j': {
        if (!args.length) return ui.focusRooms();
        const [ref, pass] = args;
        await joinOrPrompt(engine, ui, ref, pass ?? '', 'join');
        return;
      }

      case '/connect': {
        const [addr, pass] = args;
        if (!addr) return notice('usage: /connect <host:port> [passcode]', 'warn');
        await joinOrPrompt(engine, ui, addr, pass ?? '', 'connect');
        return;
      }

      case '/leave':
      case '/part':
        if (!engine.store.get().room) return notice('not in a room', 'warn');
        engine.leave();
        return;

      case '/nick':
        if (!args[0]) return notice(`you are ${engine.nick}`);
        engine.setNick(args[0]);
        return;

      case '/me':
        if (!argStr) return notice('usage: /me <action>', 'warn');
        engine.me(argStr);
        return;

      case '/dm':
      case '/msg':
      case '/w': {
        const m = /^@?(\S+)\s+([\s\S]+)$/.exec(argStr);
        if (!m) return notice('usage: /dm <nick> <message>', 'warn');
        engine.dm(m[1], m[2]);
        return;
      }

      case '/send':
      case '/file': {
        const target = args.find((a) => a.startsWith('@'))?.slice(1);
        const path = args.filter((a) => !a.startsWith('@')).join(' ');
        if (!path) return ui.openPicker(target);
        notice(`Hashing ${path}…`);
        await engine.sendFile(path, target);
        return;
      }

      case '/accept':
      case '/a': {
        const saved = await engine.accept(args[0]);
        notice(`Saved ${saved} (SHA-256 verified)`);
        return;
      }

      case '/reject':
        engine.reject(args[0]);
        return;

      case '/cancel':
        engine.cancel(args[0]);
        notice('Transfer cancelled');
        return;

      case '/paste': {
        const target = args.find((a) => a.startsWith('@'))?.slice(1);
        const text = (await readClipboard()).replace(/\s+$/, '');
        if (!text) return notice('clipboard is empty', 'warn');
        if (target) engine.dm(target, text);
        else engine.say(text);
        return;
      }

      case '/who': {
        const room = engine.store.get().room;
        if (!room) return notice('not in a room', 'warn');
        notice(`${room.members.length} in ${room.state.name}:`);
        for (const m of room.members) {
          const rank = room.successors.indexOf(m.node);
          notice(`  ${m.host ? '★' : ' '} ${m.nick.padEnd(20)} ${m.ip}${m.host ? '  host' : rank >= 0 ? `  successor #${rank + 1}` : ''}`);
        }
        return;
      }

      case '/transfers': {
        const ts = engine.store.get().transfers;
        if (!ts.length) return notice('no transfers yet');
        for (const t of ts)
          notice(
            `  ${t.xfer} ${t.direction === 'up' ? '↑' : '↓'} ${t.name} ${formatBytes(t.size)} ${t.peer} — ${t.state}${t.error ? `: ${t.error}` : ''}`,
          );
        return;
      }

      case '/clear':
        engine.store.clearFeed();
        return;

      case '/quit':
      case '/exit':
      case '/q':
        ui.quit();
        return;

      default:
        notice(`unknown command ${cmd} — /help lists them (start with // to send a literal slash)`, 'warn');
    }
  } catch (err) {
    notice((err as Error).message, 'error');
  }
}

export async function joinOrPrompt(engine: Engine, ui: CommandUI, ref: string, pass: string, mode: 'join' | 'connect'): Promise<void> {
  try {
    if (mode === 'join') await engine.join(ref, pass);
    else await engine.connect(ref, pass);
  } catch (err) {
    if (err instanceof JoinError && (err.code === 'passcode-required' || err.code === 'passcode')) {
      if (err.code === 'passcode') engine.store.notice('wrong passcode', 'error');
      const label = mode === 'join' ? (engine.findRoom(ref)?.name ?? ref) : ref;
      ui.promptPasscode(ref, label, mode);
      return;
    }
    throw err;
  }
}
