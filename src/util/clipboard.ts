import { execFile } from 'node:child_process';

/** Platform clipboard readers, tried in order. */
const READERS: Record<string, [string, string[]][]> = {
  darwin: [['pbpaste', []]],
  win32: [['powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']]],
  linux: [
    ['wl-paste', ['--no-newline']],
    ['xclip', ['-selection', 'clipboard', '-o']],
    ['xsel', ['--clipboard', '--output']],
  ],
};

export async function readClipboard(): Promise<string> {
  const readers = READERS[process.platform] ?? READERS.linux;
  let lastErr: Error | null = null;
  for (const [cmd, args] of readers) {
    try {
      return await new Promise<string>((resolve, reject) =>
        execFile(cmd, args, { maxBuffer: 1 << 20, timeout: 2000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
      );
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw new Error(`no clipboard tool available (${lastErr?.message ?? 'unsupported platform'})`);
}
