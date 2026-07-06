import stringWidth from 'string-width';

// ── ANSI escape constants ─────────────────────────────────────────────────────
// The single home for these — both the deck renderer (render.ts) and the inbox
// picker (inbox/tui.ts) import from here rather than keeping their own copies.

export const ESC = '\x1b[';
export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const DIM = `${ESC}2m`;
export const ITALIC = `${ESC}3m`;
export const RED = `${ESC}31m`;
export const GREEN = `${ESC}32m`;
export const YELLOW = `${ESC}33m`;
export const CYAN = `${ESC}36m`;
export const GRAY = `${ESC}90m`;
export const REVERSE = `${ESC}7m`;

// ── Text helpers ──────────────────────────────────────────────────────────────

const CONTROL_CHARS_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[@-_]|[\x00-\x08\x0B\x0E-\x1F\x7F-\x9F]/g;

export function sanitize(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(CONTROL_CHARS_RE, '');
}

export function singleLine(text: string): string {
  return sanitize(text).replace(/\s+/g, ' ').trim();
}

export function hline(width: number, char = '─'): string {
  if (width < 1) return '';
  return char.repeat(width);
}

export function padRight(text: string, width: number): string {
  const w = stringWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}

/** Char-based width truncation with a trailing ellipsis. The canonical deck
 *  renderer variant. */
export function truncate(text: string, maxWidth: number): string {
  if (maxWidth < 1) return '';
  if (stringWidth(text) <= maxWidth) return text;
  const chars = [...text];
  let w = 0;
  let out = '';
  for (const ch of chars) {
    const cw = stringWidth(ch);
    if (w + cw + 1 > maxWidth) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Word-aware truncation that also flattens newlines and strips decorative
 *  emoji — tuned for dense inbox rows (ported from sisyphus format.ts). Kept
 *  distinct from `truncate` because those two surfaces want different behavior. */
export function truncateRow(text: string, max: number): string {
  const clean = text.replace(/\n/g, ' ').replace(/✅/g, '✓').replace(/❌/g, '✗').replace(/\p{Emoji_Presentation}/gu, '');
  if (max < 4) return clean.slice(0, max);
  const w = stringWidth(clean);
  if (w <= max) return clean;
  let result = clean;
  while (stringWidth(result) > max - 1 && result.length > 0) {
    const cut = result.lastIndexOf(' ', result.length - 2);
    if (cut > max * 0.4) {
      result = result.slice(0, cut);
    } else {
      result = result.slice(0, result.length - 1);
    }
  }
  return result + '…';
}

function sliceByWidth(s: string, maxWidth: number): string {
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > maxWidth) break;
    out += ch;
    w += cw;
  }
  if (out === '' && s.length > 0) out = [...s][0]!;
  return out;
}

/** Word-wrap on whitespace; splits on `\n` into separate paragraphs. */
export function wrap(text: string, maxWidth: number): string[] {
  if (maxWidth < 1) return [text];
  const out: string[] = [];
  const paragraphs = text.split('\n');
  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p]!;
    if (para === '') {
      out.push('');
      continue;
    }
    const words = para.split(/[ \t]+/).filter(Boolean);
    let current = '';
    for (let word of words) {
      while (stringWidth(word) > maxWidth) {
        if (current) {
          out.push(current);
          current = '';
        }
        const piece = sliceByWidth(word, maxWidth);
        out.push(piece);
        word = word.slice(piece.length);
      }
      const candidate = current ? `${current} ${word}` : word;
      if (stringWidth(candidate) <= maxWidth) {
        current = candidate;
      } else {
        if (current) out.push(current);
        current = word;
      }
    }
    if (current) out.push(current);
  }
  return out.length > 0 ? out : [''];
}

/** Hard character wrap that ignores word boundaries; splits on `\n`. Used for
 *  free-form input buffers where every character (including runs without
 *  spaces) must stay on screen. */
export function hardWrap(text: string, maxWidth: number): string[] {
  if (maxWidth < 1) return [text];
  const segments = text.split('\n');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.length === 0) {
      out.push('');
      continue;
    }
    let current = '';
    let currentW = 0;
    for (const ch of [...seg]) {
      const cw = stringWidth(ch);
      if (currentW + cw > maxWidth) {
        out.push(current);
        current = ch;
        currentW = cw;
      } else {
        current += ch;
        currentW += cw;
      }
    }
    out.push(current);
  }
  return out;
}

/**
 * Pad each non-empty line with leading spaces to horizontally center the
 * `contentWidth`-wide block within `cols`. Wide terminals get breathing room;
 * narrow panes skip centering. Empty lines stay empty so frame diffing keeps
 * them as cheap no-ops.
 */
export function centerHorizontal(lines: string[], cols: number, contentWidth: number): string[] {
  const extraPad = Math.max(0, Math.floor((cols - contentWidth) / 2));
  if (extraPad === 0) return lines;
  const pad = ' '.repeat(extraPad);
  return lines.map((line) => (line === '' ? '' : pad + line));
}

/**
 * ANSI-aware clip: truncate a line's *visible* width to `maxWidth`, passing
 * escape sequences through untouched. Every line written to the terminal must
 * fit within the columns, or it physically wraps onto the next row — which
 * breaks diffFrame's one-logical-line-per-row model and strands spillover text
 * on rows the differ believes are empty (so it never erases them).
 */
export function clipLine(line: string, maxWidth: number): string {
  if (maxWidth < 1) return '';
  if (stringWidth(line) <= maxWidth) return line; // string-width ignores ANSI
  let out = '';
  let w = 0;
  let i = 0;
  let sawAnsi = false;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]|^\x1b[@-_]/.exec(line.slice(i));
      if (m !== null) {
        out += m[0];
        i += m[0].length;
        sawAnsi = true;
        continue;
      }
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const cw = stringWidth(ch);
    if (w + cw > maxWidth) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return sawAnsi ? out + RESET : out;
}
