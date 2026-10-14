import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Engine } from '../engine/Engine.js';
import { ChatView } from './components/ChatView.js';
import { FilePicker } from './components/FilePicker.js';
import { Sidebar } from './components/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { TextInput } from './components/TextInput.js';
import { TransferTray, visibleTransfers } from './components/TransferTray.js';
import { joinOrPrompt, runInput, type CommandUI } from './commands.js';
import { buildLines } from './lines.js';

type Mode = 'chat' | 'rooms' | 'passcode' | 'picker';

interface PassPrompt {
  ref: string;
  label: string;
  mode: 'join' | 'connect';
}

const HINTS: Record<Mode, string> = {
  chat: 'Tab rooms · ^O send file · PgUp/PgDn scroll · /help',
  rooms: '↑↓ select · ⏎ join · n new room · r refresh · Esc back',
  passcode: '⏎ submit · Esc cancel',
  picker: '',
};

export function App({ engine, onQuit }: { engine: Engine; onQuit: () => Promise<void> }) {
  const state = useSyncExternalStore(engine.store.subscribe, engine.store.get);
  const { exit } = useApp();
  const { columns: cols, rows } = useWindowSize();

  const [mode, setMode] = useState<Mode>('chat');
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [roomCursor, setRoomCursor] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [unseen, setUnseen] = useState(0);
  const [pass, setPass] = useState<PassPrompt | null>(null);
  const [pickerTarget, setPickerTarget] = useState<string | undefined>();
  const [now, setNow] = useState(Date.now());
  const quitting = useRef(false);

  // 1 Hz clock for countdowns and fading finished transfers.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const quit = useCallback(() => {
    if (quitting.current) return;
    quitting.current = true;
    engine.store.notice('Leaving…');
    void onQuit().finally(() => exit());
  }, [engine, exit, onQuit]);

  const ui: CommandUI = useMemo(
    () => ({
      openPicker: (target) => {
        setPickerTarget(target);
        setMode('picker');
      },
      focusRooms: () => setMode('rooms'),
      promptPasscode: (ref, label, m) => {
        setPass({ ref, label, mode: m });
        setInput('');
        setMode('passcode');
      },
      quit,
    }),
    [quit],
  );

  // ── layout ──
  const narrow = cols < 72;
  const sideW = mode === 'rooms' && narrow ? cols : narrow ? 0 : Math.min(32, Math.max(24, Math.floor(cols * 0.25)));
  const chatW = cols - sideW;
  const tray = visibleTransfers(state.transfers, now);
  const trayH = tray.length ? tray.length + 2 : 0;
  const mainH = Math.max(6, rows - trayH - 3 - 1);
  const bodyH = Math.max(1, mainH - 3);

  const feed = state.room ? state.room.messages : state.lobby;
  const selfNode = state.self.node;
  const members = state.room?.members;
  const lines = useMemo(
    () => buildLines(feed, Math.max(10, chatW - 4), { selfNode, nickOf: (n) => members?.find((m) => m.node === n)?.nick }),
    [feed, chatW, selfNode, members],
  );
  const maxScroll = Math.max(0, lines.length - bodyH);

  // Keep the viewport anchored when new lines arrive while scrolled up.
  const prevLen = useRef(lines.length);
  const roomId = state.room?.state.id;
  useEffect(() => {
    const delta = lines.length - prevLen.current;
    prevLen.current = lines.length;
    if (delta > 0 && scroll > 0) {
      setScroll((s) => Math.min(s + delta, Math.max(0, lines.length - bodyH)));
      setUnseen((u) => u + delta);
    }
  }, [lines.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setScroll(0);
    setUnseen(0);
  }, [roomId]);
  useEffect(() => {
    if (scroll === 0) setUnseen(0);
  }, [scroll]);
  useEffect(() => {
    setRoomCursor((c) => Math.min(c, Math.max(0, state.rooms.length - 1)));
  }, [state.rooms.length]);

  // ── keys ──
  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') return quit();
    if (mode === 'picker') return; // the picker owns the keyboard

    const page = Math.max(1, bodyH - 2);
    if (key.pageUp) return setScroll((s) => Math.min(maxScroll, s + page));
    if (key.pageDown) return setScroll((s) => Math.max(0, s - page));
    if (key.shift && key.upArrow) return setScroll((s) => Math.min(maxScroll, s + 1));
    if (key.shift && key.downArrow) return setScroll((s) => Math.max(0, s - 1));
    if (key.ctrl && ch === 'r') return engine.refreshRooms();
    if (key.ctrl && ch === 'o') return ui.openPicker();

    if (mode === 'passcode') {
      if (key.escape) {
        setPass(null);
        setInput('');
        setMode('chat');
      }
      return;
    }
    if (key.tab) {
      if (mode === 'rooms') setMode('chat');
      else {
        engine.refreshRooms();
        setMode('rooms');
      }
      return;
    }
    if (mode === 'rooms') {
      if (key.escape) return setMode('chat');
      if (key.upArrow) return setRoomCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setRoomCursor((c) => Math.min(state.rooms.length - 1, c + 1));
      if (ch === 'r') return engine.refreshRooms();
      if (ch === 'n') {
        setInput('/host ');
        return setMode('chat');
      }
      if (key.return) {
        const r = state.rooms[roomCursor];
        if (!r) return;
        setMode('chat');
        void joinOrPrompt(engine, ui, r.id, '', 'join').catch((e: Error) => engine.store.notice(e.message, 'error'));
      }
      return;
    }
    if (mode === 'chat' && key.escape) setScroll(0);
  });

  const submit = (value: string) => {
    if (mode === 'passcode' && pass) {
      setMode('chat');
      setInput('');
      setPass(null);
      void joinOrPrompt(engine, ui, pass.ref, value, pass.mode).catch((e: Error) => engine.store.notice(e.message, 'error'));
      return;
    }
    const line = value.trimEnd();
    if (!line.trim()) return;
    setHistory((h) => (h.at(-1) === line ? h : [...h, line].slice(-200)));
    setHistIdx(-1);
    setInput('');
    setScroll(0);
    void runInput(line, engine, ui);
  };

  const recall = (dir: -1 | 1) => {
    if (!history.length) return;
    const idx = histIdx === -1 ? (dir === -1 ? history.length - 1 : -1) : histIdx + dir;
    if (idx < 0 && dir === -1) return;
    if (idx >= history.length || idx < 0) {
      setHistIdx(-1);
      setInput('');
      return;
    }
    setHistIdx(idx);
    setInput(history[idx]);
  };

  const prompt = mode === 'passcode' && pass ? `passcode for ${pass.label} › ` : state.room ? `#${state.room.state.name} › ` : '› ';
  const placeholder = state.room
    ? `Message #${state.room.state.name} — /send to share a file, /help for commands`
    : 'Tab to browse rooms · /host <name> to create one · /help';

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box height={mainH}>
        {sideW > 0 ? <Sidebar state={state} width={sideW} height={mainH} focused={mode === 'rooms'} cursor={roomCursor} now={now} /> : null}
        {chatW > 0 ? (
          mode === 'picker' ? (
            <FilePicker
              width={chatW}
              height={mainH}
              target={pickerTarget}
              onCancel={() => setMode('chat')}
              onPick={(path) => {
                setMode('chat');
                engine.store.notice(`Hashing ${path}…`);
                engine.sendFile(path, pickerTarget).catch((e: Error) => engine.store.notice(e.message, 'error'));
              }}
            />
          ) : (
            <ChatView room={state.room} lines={lines} width={chatW} height={mainH} scroll={Math.min(scroll, maxScroll)} unseen={unseen} />
          )
        ) : null}
      </Box>
      <TransferTray transfers={tray} width={cols} />
      <Box borderStyle="round" borderColor={mode === 'chat' || mode === 'passcode' ? 'cyan' : 'gray'} paddingX={1} height={3} width={cols}>
        <Text color={mode === 'passcode' ? 'yellow' : 'cyan'}>{prompt}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          isActive={mode === 'chat' || mode === 'passcode'}
          mask={mode === 'passcode'}
          width={Math.max(5, cols - 4 - prompt.length)}
          placeholder={mode === 'passcode' ? '' : placeholder}
          onHistory={mode === 'chat' ? recall : undefined}
        />
      </Box>
      <StatusBar state={state} width={cols} hint={HINTS[mode]} />
    </Box>
  );
}
