#!/usr/bin/env node
import { render } from 'ink';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Engine } from './engine/Engine.js';
import { DISCOVERY_PORT } from './protocol/types.js';
import { LanTransport } from './transport/lan/LanTransport.js';
import { App } from './tui/App.js';
import { joinOrPrompt, runInput } from './tui/commands.js';
import { parseDuration } from './util/format.js';

const USAGE = `subnet — zero-cloud LAN chat & file sharing in your terminal

Usage: subnet [options]

  -n, --nick <name>        nickname (default: your OS username)
  -d, --downloads <dir>    where received files go (default: ~/Downloads/subnet)
      --host <room>        host a room on startup
      --join <room>        join a discovered room on startup (name or number)
      --connect <ip:port>  join a room by address on startup
  -p, --pass <code>        passcode for --host / --join / --connect
  -t, --ttl <dur>          make the --host room ephemeral (e.g. 30m, 2h)
      --auto-accept        download incoming files without asking (≤512 MB)
      --no-discovery       disable UDP discovery (VPN/overlay networks; use /connect)
      --port <n>           UDP discovery port (default ${DISCOVERY_PORT}; all peers must match)
      --ctrl-port <n>      TCP port for hosting rooms (default: random)
      --file-port <n>      TCP port for serving files (default: random)
  -h, --help               show this help
`;

const { values: o } = parseArgs({
  options: {
    nick: { type: 'string', short: 'n' },
    downloads: { type: 'string', short: 'd' },
    host: { type: 'string' },
    join: { type: 'string' },
    connect: { type: 'string' },
    pass: { type: 'string', short: 'p' },
    ttl: { type: 'string', short: 't' },
    'auto-accept': { type: 'boolean' },
    'no-discovery': { type: 'boolean' },
    port: { type: 'string' },
    'ctrl-port': { type: 'string' },
    'file-port': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (o.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (!process.stdin.isTTY) {
  process.stderr.write('subnet needs an interactive terminal (stdin is not a TTY)\n');
  process.exit(1);
}

const int = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    process.stderr.write(`invalid ${name}: ${v}\n`);
    process.exit(2);
  }
  return n;
};

const safeUser = () => {
  try {
    return userInfo().username;
  } catch {
    return 'anon';
  }
};

const engine = new Engine({
  nick: o.nick ?? process.env.SUBNET_NICK ?? safeUser(),
  downloadDir: resolve(o.downloads ?? join(homedir(), 'Downloads', 'subnet')),
  autoAccept: o['auto-accept'],
  ctrlPort: int(o['ctrl-port'], '--ctrl-port'),
  filePort: int(o['file-port'], '--file-port'),
  transport: new LanTransport({ discovery: o['no-discovery'] ? false : { port: int(o.port, '--port') ?? DISCOVERY_PORT } }),
});

try {
  await engine.start();
} catch (err) {
  process.stderr.write(`subnet: failed to start networking: ${(err as Error).message}\n`);
  process.exit(1);
}

const s = engine.store.get().self;
engine.store.notice(
  `Welcome to subnet, ${s.nick}. You're ${s.ip} on the ${s.transport === 'lan' ? 'local network' : 'network (discovery off)'}.`,
);
engine.store.notice(
  s.transport === 'lan'
    ? 'Rooms on your LAN appear on the left — Tab to browse, ⏎ to join. /host <name> creates one, /help lists everything.'
    : 'Discovery is off: /connect <ip:port> to join a room, /host <name> to create one.',
);
engine.store.notice(`Files you receive are saved to ${s.downloadDir}`);

let stopping: Promise<void> | null = null;
const stop = () => (stopping ??= engine.stop());

const app = render(<App engine={engine} onQuit={stop} />, {
  alternateScreen: true,
  exitOnCtrlC: false,
  maxFps: 30,
});

for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    void stop().finally(() => {
      app.unmount();
      process.exit(0);
    });
  });
}

// Startup actions from flags.
const noUI = { openPicker() {}, focusRooms() {}, quit() {}, promptPasscode() {} };
if (o.host) {
  const ttl = o.ttl ? parseDuration(o.ttl) : null;
  if (o.ttl && !ttl) engine.store.notice(`ignoring invalid --ttl ${o.ttl}`, 'warn');
  void runInput(
    `/host ${JSON.stringify(o.host)}${o.pass ? ` -p ${JSON.stringify(o.pass)}` : ''}${ttl ? ` -t ${o.ttl}` : ''}`,
    engine,
    noUI,
  );
} else if (o.connect) {
  void joinOrPrompt(engine, noUI, o.connect, o.pass ?? '', 'connect').catch((e: Error) => engine.store.notice(e.message, 'error'));
} else if (o.join) {
  // Give discovery a moment to hear the room's beacon.
  const target = o.join;
  const deadline = Date.now() + 5000;
  const tryJoin = () => {
    if (engine.findRoom(target)) {
      void joinOrPrompt(engine, noUI, target, o.pass ?? '', 'join').catch((e: Error) => engine.store.notice(e.message, 'error'));
    } else if (Date.now() < deadline) setTimeout(tryJoin, 250);
    else engine.store.notice(`no room matching "${target}" found on the LAN`, 'warn');
  };
  tryJoin();
}

await app.waitUntilExit();
await stop();
process.exit(0);
