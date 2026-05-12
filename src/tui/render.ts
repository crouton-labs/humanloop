import { execFileSync } from 'node:child_process';
import stringWidth from 'string-width';
import type { TuiState, Interaction, InteractionResponse, VisualBlock } from '../types.js';

// ── Termrender body rendering ────────────────────────────────────────────────

let _termrenderAvail: boolean | null = null;
function isTermrenderAvailable(): boolean {
  if (_termrenderAvail !== null) return _termrenderAvail;
  try {
    execFileSync('termrender', ['--version'], { stdio: 'pipe', timeout: 3000 });
    _termrenderAvail = true;
  } catch {
    _termrenderAvail = false;
  }
  return _termrenderAvail;
}

const _bodyCache = new Map<string, string[]>();

function renderBody(text: string, width: number): string[] {
  const key = `${text}\0${width}`;
  const cached = _bodyCache.get(key);
  if (cached) return cached;
  if (isTermrenderAvailable()) {
    try {
      const out = execFileSync('termrender', ['--width', String(width)], {
        input: text,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = out.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      _bodyCache.set(key, lines);
      return lines;
    } catch { /* fall through */ }
  }
  const fallback = wrap(sanitize(text), width);
  _bodyCache.set(key, fallback);
  return fallback;
}

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;

const CONTROL_CHARS_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[@-_]|[\x00-\x08\x0B\x0E-\x1F\x7F-\x9F]/g;
export function sanitize(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(CONTROL_CHARS_RE, '');
}

function singleLine(text: string): string {
  return sanitize(text).replace(/\s+/g, ' ').trim();
}

function truncate(text: string, maxWidth: number): string {
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

function padRight(text: string, width: number): string {
  const w = stringWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}

function hline(width: number, char = '─'): string {
  if (width < 1) return '';
  return char.repeat(width);
}

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

// ── Horizontal centering ─────────────────────────────────────────────────────

/**
 * Pad each non-empty line with leading spaces to horizontally center the
 * `contentWidth`-wide block within `cols`. Wide terminals (dashboard, full
 * screen) get visual breathing room; narrow panes (split tmux pane next to a
 * spawning agent) skip centering because there's nothing to center.
 *
 * Empty lines stay empty so frame diffing can keep them as cheap no-ops.
 */
function centerHorizontal(lines: string[], cols: number, contentWidth: number): string[] {
  const extraPad = Math.max(0, Math.floor((cols - contentWidth) / 2));
  if (extraPad === 0) return lines;
  const pad = ' '.repeat(extraPad);
  return lines.map((line) => (line === '' ? '' : pad + line));
}

// ── Frame buffer ─────────────────────────────────────────────────────────────

export function diffFrame(
  prevFrame: string[],
  nextLines: string[],
  rows: number,
): { writes: string[]; nextPrevFrame: string[] } {
  const writes: string[] = [];
  for (let i = 0; i < rows; i++) {
    const line = i < nextLines.length ? nextLines[i]! : '';
    if (prevFrame[i] !== line) {
      writes.push(`${ESC}${i + 1};1H${ESC}2K${line}`);
    }
  }
  return { writes, nextPrevFrame: [...nextLines] };
}

// ── Renderers ────────────────────────────────────────────────────────────────

export function renderOverview(state: TuiState, cols: number, rows: number): string[] {
  const lines: string[] = [];
  const title = `${BOLD}${CYAN} Decisions ${RESET}`;
  const progress = `${state.responses.size}/${state.interactions.length} answered`;

  lines.push('');
  lines.push(`  ${title}  ${DIM}${progress}${RESET}`);
  lines.push(`  ${DIM}${hline(Math.min(cols - 4, 60))}${RESET}`);
  lines.push('');

  type Row = { line: string; questionIndex: number };
  const rowsBuf: Row[] = [];
  for (let i = 0; i < state.interactions.length; i++) {
    const interaction = state.interactions[i]!;
    const response = state.responses.get(interaction.id);
    const icon = response ? `${GREEN}✓${RESET}` : `${DIM}○${RESET}`;
    const label = singleLine(interaction.title);
    const cursor = i === state.currentIndex ? `${CYAN}▸${RESET} ` : '  ';
    const labelMax = Math.max(10, cols - 16);
    rowsBuf.push({
      line: `  ${cursor}${icon} ${truncate(label, labelMax)}`,
      questionIndex: i,
    });
    if (response) {
      const summary = singleLine(responseSummary(response, interaction));
      const summaryMax = Math.max(10, cols - 10);
      rowsBuf.push({
        line: `      ${DIM}${truncate(summary, summaryMax)}${RESET}`,
        questionIndex: i,
      });
    }
  }

  const reserved = 4 + 3 + 2;
  const available = Math.max(1, rows - reserved);
  let scroll = state.scrollOffset || 0;
  const focusRow = rowsBuf.findIndex((r) => r.questionIndex === state.currentIndex);
  if (focusRow >= 0) {
    if (focusRow < scroll) scroll = focusRow;
    if (focusRow >= scroll + available) scroll = focusRow - available + 1;
  }
  scroll = Math.max(0, Math.min(scroll, Math.max(0, rowsBuf.length - available)));

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
  // Overview content extends roughly cols-16 wide for option labels; center
  // against a 60-col cap (the divider width) when the terminal is much wider.
  const centered = centerHorizontal(lines.slice(0, rows), cols, Math.min(cols, 60) + 2);
  return centered;
}

export function renderItemReview(state: TuiState, cols: number, rows: number): string[] {
  const interaction = state.interactions[state.currentIndex]!;
  const visual = state.visuals.get(interaction.id);
  const response = state.responses.get(interaction.id);
  const maxW = Math.min(cols - 4, 120);

  // Pre-body: position, divider, title, subtitle (always visible)
  const preLines: string[] = [];
  const pos = `${state.currentIndex + 1}/${state.interactions.length}`;
  preLines.push('');
  preLines.push(`  ${BOLD}${CYAN}[${pos}]${RESET}`);
  preLines.push(`  ${DIM}${hline(maxW)}${RESET}`);
  preLines.push('');
  for (const line of wrap(sanitize(interaction.title), maxW)) {
    preLines.push(`  ${BOLD}${line}${RESET}`);
  }
  if (interaction.subtitle) {
    for (const line of wrap(sanitize(interaction.subtitle), maxW)) {
      preLines.push(`  ${DIM}${line}${RESET}`);
    }
  }

  // Body: rendered question body + expanded visual block (scrollable)
  const bodyLines: string[] = [];
  if (interaction.body) {
    bodyLines.push('');
    for (const line of renderBody(interaction.body, maxW)) {
      bodyLines.push(`  ${line}`);
    }
  }
  if (visual && visual.status === 'ready' && state.detailExpanded) {
    bodyLines.push('');
    bodyLines.push(`  ${DIM}── context ${hline(maxW - 12)}${RESET}`);
    for (const vl of visual.content.split('\n')) {
      bodyLines.push(`  ${vl}`);
    }
    bodyLines.push(`  ${DIM}${hline(maxW)}${RESET}`);
  }

  // Post-body: visual status hint, input buffer or actions, footer (always visible)
  const postLines: string[] = [];
  postLines.push('');
  if (visual) {
    if (visual.status === 'loading') {
      postLines.push(`  ${DIM}loading context...${RESET}`);
      postLines.push('');
    } else if (visual.status === 'error') {
      postLines.push(`  ${YELLOW}visual context unavailable${RESET}`);
      postLines.push('');
    } else if (!state.detailExpanded) {
      postLines.push(`  ${DIM}[space] expand context${RESET}`);
      postLines.push('');
    }
  }

  if (state.inputMode) {
    postLines.push(`  ${DIM}${hline(maxW)}${RESET}`);
    const label = interaction.freetextLabel !== undefined
      ? interaction.freetextLabel
      : state.inputMode.kind === 'comment' ? 'Comment' : 'Response';

    // Show attached option (comment mode only) — Tab cycles
    let attachedLine: string | undefined;
    if (state.inputMode.kind === 'comment') {
      const attachedId = state.inputMode.selectedOptionId;
      const opts = interaction.options;
      if (opts.length > 0) {
        const attached = attachedId !== undefined
          ? opts.find((o) => o.id === attachedId)
          : undefined;
        const valueText = attached !== undefined
          ? `${CYAN}${singleLine(attached.label)}${RESET}`
          : `${DIM}none${RESET}`;
        attachedLine = `  ${DIM}attached:${RESET} ${valueText}  ${DIM}[tab to cycle]${RESET}`;
      }
    }

    postLines.push(`  ${YELLOW}${label}:${RESET}`);
    const bufLines = hardWrap(state.inputMode.buffer, maxW - 1);
    for (let i = 0; i < bufLines.length; i++) {
      const isLast = i === bufLines.length - 1;
      postLines.push(`  ${bufLines[i]}${isLast ? '█' : ''}`);
    }
    if (attachedLine !== undefined) {
      postLines.push('');
      postLines.push(attachedLine);
    }
    postLines.push('');
    postLines.push(`  ${DIM}enter${RESET} submit  ${DIM}esc${RESET} cancel`);
  } else {
    postLines.push(...renderActions(interaction, state.selectedAction, maxW, response));
  }

  // Window the body
  const reservedRows = preLines.length + postLines.length + 1; // +1 for footer
  const bodyHeight = Math.max(1, rows - reservedRows);
  const overflows = bodyLines.length > bodyHeight;
  let scroll = state.scrollOffset || 0;
  const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
  scroll = Math.max(0, Math.min(scroll, maxScroll));
  state.scrollOffset = scroll;

  let visibleBody: string[];
  if (overflows) {
    visibleBody = bodyLines.slice(scroll, scroll + bodyHeight);
    if (scroll > 0) {
      visibleBody[0] = `  ${DIM}↑ ${scroll} more above${RESET}`;
    }
    const remainingBelow = bodyLines.length - (scroll + bodyHeight);
    if (remainingBelow > 0) {
      visibleBody[visibleBody.length - 1] = `  ${DIM}↓ ${remainingBelow} more below${RESET}`;
    }
  } else {
    visibleBody = bodyLines;
  }

  // Footer hint — mention scroll keys when body overflows
  const footerParts = [
    `${DIM}n/p${RESET} prev/next`,
    `${DIM}space${RESET} expand`,
    `${DIM}q${RESET} overview`,
  ];
  if (overflows) footerParts.unshift(`${DIM}u/d${RESET} scroll`);
  const footer = `  ${footerParts.join('  ')}`;

  // Assemble — pad to fill rows so post-body sits at the bottom
  const lines: string[] = [...preLines, ...visibleBody, ...postLines];
  while (lines.length < rows - 1) lines.push('');
  lines.push(footer);

  // Final clamp (safety net for very small terminals)
  const clamped = lines.length > rows
    ? [...lines.slice(0, rows - 1), footer]
    : lines;
  // Content occupies maxW cols of body + 2 cols of left prefix — center the
  // whole block when the terminal is wider than that.
  return centerHorizontal(clamped, cols, maxW + 2);
}

function renderActions(
  interaction: Interaction,
  selectedAction: number,
  maxW: number,
  existing?: InteractionResponse,
): string[] {
  const lines: string[] = [];
  const opts = interaction.options;
  // Prefix on first row: "  X [s] " — 2 + 1 (cursor) + 1 + 3 ([s]) + 1 = 8 visible cols.
  // Continuation rows align under the label so each option reads as a block.
  const prefixWidth = 8;
  const indent = ' '.repeat(prefixWidth);
  const contentMax = Math.max(20, maxW - prefixWidth);

  for (let i = 0; i < opts.length; i++) {
    const o = opts[i]!;
    const cursor = i === selectedAction ? `${CYAN}▸${RESET}` : ' ';
    const sc = o.shortcut ?? ' ';
    const keyBadge = `${DIM}[${sc}]${RESET}`;

    const labelLines = wrap(sanitize(o.label), contentMax);
    for (let j = 0; j < labelLines.length; j++) {
      const prefix = j === 0 ? `  ${cursor} ${keyBadge} ` : indent;
      lines.push(`${prefix}${labelLines[j]}`);
    }
    if (o.description) {
      const descLines = wrap(`— ${sanitize(o.description)}`, contentMax);
      for (const dl of descLines) {
        lines.push(`${indent}${DIM}${dl}${RESET}`);
      }
    }
  }

  if (interaction.allowFreetext && opts.length > 0) {
    const cursor = opts.length === selectedAction ? `${CYAN}▸${RESET}` : ' ';
    const label = interaction.freetextLabel !== undefined ? interaction.freetextLabel : 'Add comment';
    lines.push(`  ${cursor} ${DIM}[c]${RESET} ${label}`);
  } else if (interaction.allowFreetext && opts.length === 0) {
    const ftLabel = interaction.freetextLabel !== undefined ? interaction.freetextLabel : 'Enter response';
    lines.push(`  ${DIM}[r]${RESET} ${ftLabel}`);
  }

  if (existing) {
    lines.push('');
    lines.push(`  ${GREEN}Current: ${responseSummary(existing, interaction)}${RESET}`);
  }

  return lines;
}

export function renderFinal(state: TuiState, cols: number, rows: number): string[] {
  const header: string[] = [];
  const footer: string[] = [];
  const maxW = Math.min(cols - 4, 60);
  const total = state.interactions.length;
  const answered = state.responses.size;

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

  const questionRows: string[] = [];
  for (const interaction of state.interactions) {
    const response = state.responses.get(interaction.id);
    const icon = response ? `${GREEN}✓${RESET}` : `${YELLOW}○${RESET}`;
    const label = singleLine(interaction.title);
    questionRows.push(`  ${icon} ${truncate(label, Math.max(10, maxW - 4))}`);
    if (response) {
      questionRows.push(`    ${DIM}${truncate(singleLine(responseSummary(response, interaction)), Math.max(10, maxW - 6))}${RESET}`);
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
  return centerHorizontal(lines.slice(0, rows), cols, maxW + 2);
}

export function responseSummary(r: InteractionResponse, interaction: Interaction): string {
  const opt = r.selectedOptionId
    ? interaction.options.find((o) => o.id === r.selectedOptionId)
    : undefined;
  if (opt && r.freetext) return `${sanitize(opt.label)}: "${sanitize(r.freetext)}"`;
  if (opt) return sanitize(opt.label);
  if (r.freetext) return sanitize(r.freetext);
  return '(empty)';
}
