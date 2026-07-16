export interface Key {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  /** Word-wise cursor motion (ctrl/alt + arrow, or readline alt-b / alt-f). */
  wordLeft: boolean;
  wordRight: boolean;
  home: boolean;
  end: boolean;
  pageUp: boolean;
  pageDown: boolean;
  /** Forward delete (the Del key / \x1b[3~). */
  del: boolean;
  return: boolean;
  /** Newline-insert chord (ctrl+j / alt+enter) — distinct from return=submit. */
  newline: boolean;
  escape: boolean;
  ctrl: boolean;
  meta: boolean;
  tab: boolean;
  backTab: boolean;
  backspace: boolean;
}

export type KeypressHandler = (input: string, key: Key) => void;

function emptyKey(): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    wordLeft: false,
    wordRight: false,
    home: false,
    end: false,
    pageUp: false,
    pageDown: false,
    del: false,
    return: false,
    newline: false,
    escape: false,
    ctrl: false,
    meta: false,
    tab: false,
    backTab: false,
    backspace: false,
  };
}

export function parseKeypress(data: Buffer): { input: string; key: Key } {
  const str = data.toString('utf8');
  const key = emptyKey();

  if (str === '\x1b[A') { key.upArrow = true; return { input: '', key }; }
  if (str === '\x1b[B') { key.downArrow = true; return { input: '', key }; }
  if (str === '\x1b[C') { key.rightArrow = true; return { input: '', key }; }
  if (str === '\x1b[D') { key.leftArrow = true; return { input: '', key }; }
  // Word-wise motion: ctrl/alt + left/right (xterm modifier encodings) and the
  // readline alt-b / alt-f bindings. Must precede the bare-ESC checks below.
  if (str === '\x1b[1;5C' || str === '\x1b[1;3C' || str === '\x1bf') { key.wordRight = true; return { input: '', key }; }
  if (str === '\x1b[1;5D' || str === '\x1b[1;3D' || str === '\x1bb') { key.wordLeft = true; return { input: '', key }; }
  if (str === '\x1b[H' || str === '\x1b[1~') { key.home = true; return { input: '', key }; }
  if (str === '\x1b[F' || str === '\x1b[4~') { key.end = true; return { input: '', key }; }
  if (str === '\x1b[5~') { key.pageUp = true; return { input: '', key }; }
  if (str === '\x1b[6~') { key.pageDown = true; return { input: '', key }; }
  if (str === '\x1b[3~') { key.del = true; return { input: '', key }; }
  if (str === '\x1b[Z') { key.backTab = true; return { input: '', key }; }
  // Alt+Enter inserts a newline in freetext (distinct from Enter=submit). Must
  // precede the bare-ESC and meta-backspace checks so the two-byte sequence
  // isn't swallowed as a lone escape.
  if (str === '\x1b\r' || str === '\x1b\n') { key.newline = true; return { input: '', key }; }
  // Enter (submit) is CR; ctrl+j (LF) inserts a newline. Splitting them lets
  // freetext use ctrl+j for a hard newline while Enter still submits. In a raw
  // TTY the Enter key sends CR, so this split is safe.
  if (str === '\r') { key.return = true; return { input: '', key }; }
  if (str === '\n') { key.newline = true; return { input: '', key }; }
  // Alt+Backspace: terminals send ESC followed by DEL/BS. Must precede the
  // bare-ESC check so the two-byte sequence isn't swallowed as plain escape.
  // iTerm2 (and many readline configs) instead map Option/Alt+Backspace to a
  // bare Ctrl-W (0x17, the "word-erase" byte) with no ESC prefix — fold it into
  // the same meta+backspace key so the word-delete path fires either way. This
  // must also precede the generic Ctrl-<letter> branch below, which would
  // otherwise turn 0x17 into a literal 'w' in the buffer.
  if (str === '\x1b\x7f' || str === '\x1b\b' || str === '\x17') {
    key.meta = true;
    key.backspace = true;
    return { input: '', key };
  }
  if (str === '\x1b') { key.escape = true; return { input: '', key }; }
  if (str === '\t') { key.tab = true; return { input: '', key }; }
  if (str === '\x7f' || str === '\b') { key.backspace = true; return { input: '', key }; }

  if (str.length === 1 && str.charCodeAt(0) < 32) {
    key.ctrl = true;
    const ch = String.fromCharCode(str.charCodeAt(0) + 64).toLowerCase();
    return { input: ch, key };
  }

  // Multi-byte chunks (paste, multi-byte UTF-8, unknown escape sequences)
  // are returned as-is in `input`; the input-mode handler is responsible for
  // sanitising them before appending to its buffer. Top-level handlers
  // ignore strings of length > 1, which is the desired behaviour for
  // accidentally pasted text in overview/item-review.
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
