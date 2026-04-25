import stringWidth from 'string-width';
import type { TuiState, Question, Answer, VisualBlock } from '../types.js';
import { getTerminalSize } from './terminal.js';

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const BLUE = `${ESC}34m`;
const MAGENTA = `${ESC}35m`;
const CYAN = `${ESC}36m`;
const GRAY = `${ESC}90m`;
const BG_BLUE = `${ESC}44m`;
const WHITE = `${ESC}37m`;

// Strip ANSI escape sequences and other C0/C1 control bytes from user-supplied
// text so it can't poison the alt-screen buffer (cursor moves, color bleed,
// embedded \x1b[2J that clears the screen, etc). Keeps \n and \t which the
// wrappers handle explicitly.
const CONTROL_CHARS_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[@-_]|[\x00-\x08\x0B\x0E-\x1F\x7F-\x9F]/g;
export function sanitize(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(CONTROL_CHARS_RE, '');
}

// For one-line displays (overview rows, summaries): collapse all whitespace
// — including newlines and tabs — to single spaces so the row stays one line.
function singleLine(text: string): string {
  return sanitize(text).replace(/\s+/g, ' ').trim();
}

function truncate(text: string, maxWidth: number): string {
  if (maxWidth < 1) return '';
  if (stringWidth(text) <= maxWidth) return text;
  // Iterate by codepoint, not UTF-16 code unit, so surrogate pairs don't split.
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

function padRight(text: string, width: number): string {
  const w = stringWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}

function hline(width: number, char = '─'): string {
  if (width < 1) return '';
  return char.repeat(width);
}

// Word-wrap that ALSO respects \n as a hard break and ALSO breaks oversized
// words at maxWidth so a single 200-char token doesn't overflow the frame.
function wrap(text: string, maxWidth: number): string[] {
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
      // Hard-break a word that's wider than the line.
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

// Take the longest prefix of `s` whose visible width is <= maxWidth.
function sliceByWidth(s: string, maxWidth: number): string {
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > maxWidth) break;
    out += ch;
    w += cw;
  }
  // Always advance at least one character so we don't loop forever on
  // a single zero-width or oversized glyph.
  if (out === '' && s.length > 0) out = [...s][0]!;
  return out;
}

function hardWrap(text: string, maxWidth: number): string[] {
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
    // Iterate by codepoint so emoji surrogate pairs stay intact.
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

// ── Frame buffer ─────────────────────────────────────────────────────────────

let prevFrame: string[] = [];

export function flush(lines: string[]): void {
  const { rows } = getTerminalSize();
  process.stdout.write('\x1b[?2026h');

  for (let i = 0; i < rows; i++) {
    const line = i < lines.length ? lines[i]! : '';
    if (prevFrame[i] !== line) {
      process.stdout.write(`${ESC}${i + 1};1H${ESC}2K${line}`);
    }
  }

  process.stdout.write('\x1b[?2026l');
  prevFrame = [...lines];
}

// ── Renderers ────────────────────────────────────────────────────────────────

export function renderOverview(state: TuiState): string[] {
  const { cols, rows } = getTerminalSize();
  const lines: string[] = [];
  const title = `${BOLD}${CYAN} Decisions ${RESET}`;
  const progress = `${state.answers.size}/${state.questions.length} answered`;

  lines.push('');
  lines.push(`  ${title}  ${DIM}${progress}${RESET}`);
  lines.push(`  ${DIM}${hline(Math.min(cols - 4, 60))}${RESET}`);
  lines.push('');

  // Build all question rows with mapping back to question index so we can
  // scroll while keeping `currentIndex` visible.
  type Row = { line: string; questionIndex: number };
  const rowsBuf: Row[] = [];
  for (let i = 0; i < state.questions.length; i++) {
    const q = state.questions[i]!;
    const answer = state.answers.get(q.id);
    const icon = answer ? `${GREEN}✓${RESET}` : `${DIM}○${RESET}`;
    const label = singleLine(q.type === 'validation' ? q.statement : q.question);
    const typeTag = `${DIM}[${q.type}]${RESET}`;
    const cursor = i === state.currentIndex ? `${CYAN}▸${RESET} ` : '  ';
    const labelMax = Math.max(10, cols - 20);
    rowsBuf.push({
      line: `  ${cursor}${icon} ${truncate(label, labelMax)} ${typeTag}`,
      questionIndex: i,
    });
    if (answer) {
      const summary = singleLine(answerSummary(answer));
      const summaryMax = Math.max(10, cols - 10);
      rowsBuf.push({
        line: `      ${DIM}${truncate(summary, summaryMax)}${RESET}`,
        questionIndex: i,
      });
    }
  }

  // Reserve space for header (4 already pushed) + footer (3) + scroll hints (2).
  const reserved = 4 + 3 + 2;
  const available = Math.max(1, rows - reserved);
  let scroll = state.scrollOffset || 0;
  // Find first row matching currentIndex; ensure it's in [scroll, scroll+available).
  const focusRow = rowsBuf.findIndex((r) => r.questionIndex === state.currentIndex);
  if (focusRow >= 0) {
    if (focusRow < scroll) scroll = focusRow;
    if (focusRow >= scroll + available) scroll = focusRow - available + 1;
  }
  scroll = Math.max(0, Math.min(scroll, Math.max(0, rowsBuf.length - available)));
  state.scrollOffset = scroll;

  if (scroll > 0) {
    lines.push(`  ${DIM}↑ ${scroll} more above${RESET}`);
  } else {
    lines.push('');
  }
  const end = Math.min(rowsBuf.length, scroll + available);
  for (let i = scroll; i < end; i++) lines.push(rowsBuf[i]!.line);
  if (end < rowsBuf.length) {
    lines.push(`  ${DIM}↓ ${rowsBuf.length - end} more below${RESET}`);
  } else {
    lines.push('');
  }

  lines.push(`  ${DIM}${hline(Math.min(cols - 4, 60))}${RESET}`);
  lines.push(`  ${DIM}enter${RESET} review  ${DIM}j/k${RESET} navigate  ${DIM}q${RESET} finish`);

  while (lines.length < rows) lines.push('');
  return lines.slice(0, rows);
}

export function renderItemReview(state: TuiState): string[] {
  const { cols, rows } = getTerminalSize();
  const lines: string[] = [];
  const q = state.questions[state.currentIndex]!;
  const visual = state.visuals.get(q.id);
  const answer = state.answers.get(q.id);
  const maxW = Math.min(cols - 4, 76);

  // Header
  const pos = `${state.currentIndex + 1}/${state.questions.length}`;
  lines.push('');
  lines.push(`  ${BOLD}${CYAN}[${pos}]${RESET} ${DIM}${q.type}${RESET}`);
  lines.push(`  ${DIM}${hline(maxW)}${RESET}`);
  lines.push('');

  // Question / Statement
  const headline = sanitize(q.type === 'validation' ? q.statement : q.question);
  for (const line of wrap(headline, maxW)) {
    lines.push(`  ${BOLD}${line}${RESET}`);
  }
  for (const line of wrap(sanitize(q.rationale), maxW)) {
    lines.push(`  ${ITALIC}${GRAY}${line}${RESET}`);
  }
  lines.push('');

  // Visual context
  if (visual) {
    if (visual.status === 'loading') {
      lines.push(`  ${DIM}loading context...${RESET}`);
    } else if (visual.status === 'error') {
      lines.push(`  ${YELLOW}visual context unavailable${RESET}`);
    } else if (state.detailExpanded) {
      lines.push(`  ${DIM}── context ${hline(maxW - 12)}${RESET}`);
      for (const vl of visual.content.split('\n')) {
        lines.push(`  ${vl}`);
      }
      lines.push(`  ${DIM}${hline(maxW)}${RESET}`);
    } else {
      lines.push(`  ${DIM}[space] expand context${RESET}`);
    }
    lines.push('');
  }

  // Input mode
  if (state.inputMode) {
    lines.push(`  ${DIM}${hline(maxW)}${RESET}`);
    const label = state.inputMode.kind === 'comment' ? 'Comment'
      : state.inputMode.kind === 'freetext' ? 'Response'
      : 'Custom option';
    lines.push(`  ${YELLOW}${label}:${RESET}`);
    const bufLines = hardWrap(state.inputMode.buffer, maxW - 1);
    for (let i = 0; i < bufLines.length; i++) {
      const isLast = i === bufLines.length - 1;
      lines.push(`  ${bufLines[i]}${isLast ? '█' : ''}`);
    }
    lines.push('');
    lines.push(`  ${DIM}enter${RESET} submit  ${DIM}esc${RESET} cancel`);
  } else {
    // Actions
    lines.push(...renderActions(q, state.selectedAction, answer));
  }

  // Footer
  while (lines.length < rows - 1) lines.push('');
  const footerParts = [
    `${DIM}n/p${RESET} prev/next`,
    `${DIM}space${RESET} expand`,
    `${DIM}q${RESET} overview`,
  ];
  lines.push(`  ${footerParts.join('  ')}`);

  // If the headline + visual + actions overflowed the viewport, the footer
  // would otherwise scroll off the bottom. Clip to `rows` so flush() never
  // writes more rows than the terminal has.
  if (lines.length > rows) {
    return [...lines.slice(0, rows - 1), lines[lines.length - 1]!];
  }
  return lines;
}

function renderActions(q: Question, selectedAction: number, existing?: Answer): string[] {
  const lines: string[] = [];

  if (q.type === 'validation') {
    const actions = [
      { key: '1', label: 'Approve', desc: 'accept as stated' },
      { key: '2', label: 'Approve + comment', desc: 'accept with note' },
      { key: '3', label: 'Reject', desc: 'do not accept as stated' },
      { key: '4', label: 'Comment', desc: 'feedback without decision' },
    ];
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i]!;
      const cursor = i === selectedAction ? `${CYAN}▸${RESET}` : ' ';
      const keyBadge = `${DIM}[${a.key}]${RESET}`;
      lines.push(`  ${cursor} ${keyBadge} ${a.label} ${DIM}— ${a.desc}${RESET}`);
    }
  } else if (q.type === 'choice') {
    for (let i = 0; i < q.options.length; i++) {
      const cursor = i === selectedAction ? `${CYAN}▸${RESET}` : ' ';
      // Numeric shortcut only for 1..9 — past that, the digit '1' would fire
      // before the user can type the second digit, so we use a blank pad.
      const keyBadge = i < 9 ? `${DIM}[${i + 1}]${RESET}` : `${DIM}   ${RESET}`;
      lines.push(`  ${cursor} ${keyBadge} ${sanitize(q.options[i]!)}`);
    }
    const otherIdx = q.options.length;
    const cursor = otherIdx === selectedAction ? `${CYAN}▸${RESET}` : ' ';
    const otherBadge = otherIdx < 9 ? `${DIM}[${otherIdx + 1}]${RESET}` : `${DIM}   ${RESET}`;
    lines.push(`  ${cursor} ${otherBadge} ${ITALIC}Other (custom)${RESET}`);
  } else {
    lines.push(`  ${DIM}[r]${RESET} Enter response`);
  }

  if (existing) {
    lines.push('');
    lines.push(`  ${GREEN}Current: ${answerSummary(existing)}${RESET}`);
  }

  return lines;
}

export function renderFinal(state: TuiState): string[] {
  const { cols, rows } = getTerminalSize();
  const header: string[] = [];
  const footer: string[] = [];
  const maxW = Math.min(cols - 4, 60);
  const total = state.questions.length;
  const answered = state.answers.size;

  header.push('');
  header.push(`  ${BOLD}${CYAN} Summary ${RESET}`);
  header.push(`  ${DIM}${hline(maxW)}${RESET}`);
  header.push('');
  header.push(`  ${answered}/${total} questions answered`);
  header.push('');

  footer.push('');
  footer.push(`  ${DIM}${hline(maxW)}${RESET}`);
  if (answered < total) {
    footer.push(`  ${YELLOW}${total - answered} unanswered — press p to go back${RESET}`);
  }
  footer.push(`  ${DIM}enter${RESET} submit  ${DIM}p${RESET} go back`);

  // Build per-question rows so we can clip to fit the viewport while
  // keeping the header + footer always visible (the keybind hint at the
  // bottom is essential — without it the user can't submit).
  const questionRows: string[] = [];
  for (const q of state.questions) {
    const answer = state.answers.get(q.id);
    const icon = answer ? `${GREEN}✓${RESET}` : `${YELLOW}○${RESET}`;
    const label = singleLine(q.type === 'validation' ? q.statement : q.question);
    questionRows.push(`  ${icon} ${truncate(label, Math.max(10, maxW - 4))}`);
    if (answer) {
      questionRows.push(`    ${DIM}${truncate(singleLine(answerSummary(answer)), Math.max(10, maxW - 6))}${RESET}`);
    }
  }

  const available = Math.max(1, rows - header.length - footer.length - 1);
  let visible = questionRows;
  if (questionRows.length > available) {
    visible = [
      ...questionRows.slice(0, available - 1),
      `  ${DIM}… ${questionRows.length - (available - 1)} more rows omitted${RESET}`,
    ];
  }

  const lines = [...header, ...visible, ...footer];
  while (lines.length < rows) lines.push('');
  return lines.slice(0, rows);
}

function answerSummary(a: Answer): string {
  switch (a.type) {
    case 'validation':
      return a.approved
        ? (a.comment ? `approved: "${sanitize(a.comment)}"` : 'approved')
        : (a.comment ? `commented: "${sanitize(a.comment)}"` : 'commented');
    case 'choice':
      return a.isCustom ? `custom: "${sanitize(a.selected)}"` : sanitize(a.selected);
    case 'freetext':
      return sanitize(a.response);
  }
}
