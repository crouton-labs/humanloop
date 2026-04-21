export interface Key {
  upArrow: boolean;
  downArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  tab: boolean;
  backspace: boolean;
}

export type KeypressHandler = (input: string, key: Key) => void;

function emptyKey(): Key {
  return {
    upArrow: false,
    downArrow: false,
    return: false,
    escape: false,
    ctrl: false,
    tab: false,
    backspace: false,
  };
}

export function parseKeypress(data: Buffer): { input: string; key: Key } {
  const str = data.toString('utf8');
  const key = emptyKey();

  if (str === '\x1b[A') { key.upArrow = true; return { input: '', key }; }
  if (str === '\x1b[B') { key.downArrow = true; return { input: '', key }; }
  if (str === '\r' || str === '\n') { key.return = true; return { input: '', key }; }
  if (str === '\x1b') { key.escape = true; return { input: '', key }; }
  if (str === '\t') { key.tab = true; return { input: '', key }; }
  if (str === '\x7f' || str === '\b') { key.backspace = true; return { input: '', key }; }

  if (str.length === 1 && str.charCodeAt(0) < 32) {
    key.ctrl = true;
    const ch = String.fromCharCode(str.charCodeAt(0) + 64).toLowerCase();
    return { input: ch, key };
  }

  return { input: str, key };
}

export function setupTerminal(): void {
  if (!process.stdin.isTTY) {
    throw new Error('hl requires an interactive terminal (TTY)');
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?25l'); // hide cursor
  process.stdout.write('\x1b[?1049h'); // alt screen
  process.stdout.write('\x1b[2J\x1b[H'); // clear
}

export function restoreTerminal(): void {
  process.stdout.write('\x1b[?25h'); // show cursor
  process.stdout.write('\x1b[?1049l'); // restore screen
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

export function getTerminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}
