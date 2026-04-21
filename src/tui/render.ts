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

function truncate(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  let w = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const cw = stringWidth(text[i]!);
    if (w + cw + 1 > maxWidth) break;
    w += cw;
  }
  return text.slice(0, i) + '…';
}

function padRight(text: string, width: number): string {
  const w = stringWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}

function hline(width: number, char = '─'): string {
  return char.repeat(width);
}

function wrap(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (stringWidth(candidate) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
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
    for (const ch of seg) {
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

  for (let i = 0; i < state.questions.length; i++) {
    const q = state.questions[i]!;
    const answer = state.answers.get(q.id);
    const icon = answer ? `${GREEN}✓${RESET}` : `${DIM}○${RESET}`;
    const label = q.type === 'validation' ? q.statement : q.question;
    const typeTag = `${DIM}[${q.type}]${RESET}`;
    const cursor = i === state.currentIndex ? `${CYAN}▸${RESET} ` : '  ';

    lines.push(`  ${cursor}${icon} ${truncate(label, cols - 20)} ${typeTag}`);

    if (answer) {
      const summary = answerSummary(answer);
      lines.push(`      ${DIM}${truncate(summary, cols - 10)}${RESET}`);
    }
  }

  lines.push('');
  lines.push(`  ${DIM}${hline(Math.min(cols - 4, 60))}${RESET}`);
  lines.push(`  ${DIM}enter${RESET} review  ${DIM}j/k${RESET} navigate  ${DIM}q${RESET} finish`);

  while (lines.length < rows) lines.push('');
  return lines;
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
  const headline = q.type === 'validation' ? q.statement : q.question;
  for (const line of wrap(headline, maxW)) {
    lines.push(`  ${BOLD}${line}${RESET}`);
  }
  for (const line of wrap(q.rationale, maxW)) {
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
      const keyBadge = `${DIM}[${i + 1}]${RESET}`;
      lines.push(`  ${cursor} ${keyBadge} ${q.options[i]}`);
    }
    const otherIdx = q.options.length;
    const cursor = otherIdx === selectedAction ? `${CYAN}▸${RESET}` : ' ';
    lines.push(`  ${cursor} ${DIM}[${otherIdx + 1}]${RESET} ${ITALIC}Other (custom)${RESET}`);
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
  const lines: string[] = [];
  const maxW = Math.min(cols - 4, 60);
  const total = state.questions.length;
  const answered = state.answers.size;

  lines.push('');
  lines.push(`  ${BOLD}${CYAN} Summary ${RESET}`);
  lines.push(`  ${DIM}${hline(maxW)}${RESET}`);
  lines.push('');
  lines.push(`  ${answered}/${total} questions answered`);
  lines.push('');

  for (const q of state.questions) {
    const answer = state.answers.get(q.id);
    const icon = answer ? `${GREEN}✓${RESET}` : `${YELLOW}○${RESET}`;
    const label = q.type === 'validation' ? q.statement : q.question;
    lines.push(`  ${icon} ${truncate(label, maxW - 4)}`);
    if (answer) {
      lines.push(`    ${DIM}${truncate(answerSummary(answer), maxW - 6)}${RESET}`);
    }
  }

  lines.push('');
  lines.push(`  ${DIM}${hline(maxW)}${RESET}`);

  if (answered < total) {
    lines.push(`  ${YELLOW}${total - answered} unanswered — press p to go back${RESET}`);
  }
  lines.push(`  ${DIM}enter${RESET} submit  ${DIM}p${RESET} go back`);

  while (lines.length < rows) lines.push('');
  return lines;
}

function answerSummary(a: Answer): string {
  switch (a.type) {
    case 'validation':
      return a.approved
        ? (a.comment ? `approved: "${a.comment}"` : 'approved')
        : (a.comment ? `commented: "${a.comment}"` : 'commented');
    case 'choice':
      return a.isCustom ? `custom: "${a.selected}"` : a.selected;
    case 'freetext':
      return a.response;
  }
}
