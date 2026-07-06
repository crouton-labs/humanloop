import stringWidth from 'string-width';
import type { TuiState, Interaction, InteractionResponse, VisualBlock } from '../types.js';
import { renderMarkdown } from '../render/termrender.js';

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

export function diffFrame(
  prevFrame: string[],
  nextLines: string[],
  rows: number,
  cols?: number,
): { writes: string[]; nextPrevFrame: string[] } {
  const clipped = cols !== undefined
    ? nextLines.map((l) => clipLine(l, cols))
    : nextLines;
  const writes: string[] = [];
  for (let i = 0; i < rows; i++) {
    const line = i < clipped.length ? clipped[i]! : '';
    if (prevFrame[i] !== line) {
      writes.push(`${ESC}${i + 1};1H${ESC}2K${line}`);
    }
  }
  return { writes, nextPrevFrame: [...clipped] };
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
    const preAnswered = state.preAnsweredIds.has(interaction.id);
    const icon = response
      ? (preAnswered ? `${DIM}◆${RESET}` : `${GREEN}✓${RESET}`)
      : `${DIM}○${RESET}`;
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
  // "Previously answered" marker — shown only while the seed is intact (no user
  // override yet). The label comes from preAnswered.label so callers can be
  // domain-specific ("Previously approved", "Carried over from prior pass").
  if (state.preAnsweredIds.has(interaction.id)) {
    const customLabel = interaction.preAnswered !== undefined ? interaction.preAnswered.label : undefined;
    const label = typeof customLabel === 'string' && customLabel.length > 0
      ? customLabel
      : 'Previously answered';
    preLines.push(`  ${DIM}${ITALIC}◆ ${sanitize(label)} — press n/p to review, or any option to override${RESET}`);
  }

  // Body: rendered question body + expanded visual block (scrollable)
  const bodyLines: string[] = [];
  if (interaction.body) {
    bodyLines.push('');
    for (const line of renderMarkdown(interaction.body, maxW)) {
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

    // Show attached option in comment mode. For single-select the comment
    // qualifies the pick; for multi-select an attached option means the
    // comment is saved as a per-option note (and auto-checks the option).
    let attachedLine: string | undefined;
    if (state.inputMode.kind === 'comment') {
      const attachedId = state.inputMode.selectedOptionId;
      const opts = interaction.options;
      if (opts.length > 0) {
        const attached = attachedId !== undefined
          ? opts.find((o) => o.id === attachedId)
          : undefined;
        const valueText = attached !== undefined
          ? `${CYAN}${truncate(singleLine(attached.label), Math.max(10, maxW - 28))}${RESET}`
          : `${DIM}none (overall)${RESET}`;
        attachedLine = `  ${DIM}attached:${RESET} ${valueText}  ${DIM}[tab to cycle]${RESET}`;
      }
    }

    for (const labelLine of wrap(`${singleLine(label)}:`, maxW)) {
      postLines.push(`  ${YELLOW}${labelLine}${RESET}`);
    }
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

  // Transient hint (e.g. an empty multi-select Enter that was rejected). Sits
  // just above the footer; cleared on the next keypress.
  if (state.hint !== undefined && state.hint.length > 0) {
    postLines.push('');
    for (const hintLine of wrap(sanitize(state.hint), maxW)) {
      postLines.push(`  ${YELLOW}${hintLine}${RESET}`);
    }
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
  const footerParts = interaction.multiSelect === true
    ? [
        `${DIM}n/p${RESET} prev/next`,
        `${DIM}space${RESET} toggle`,
        `${DIM}enter${RESET} confirm`,
        `${DIM}q${RESET} overview`,
      ]
    : [
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
  const multi = interaction.multiSelect === true;
  const checked = new Set(existing?.selectedOptionIds ?? []);
  const prefixWidth = multi ? 12 : 8;
  const indent = ' '.repeat(prefixWidth);
  const contentMax = Math.max(20, maxW - prefixWidth);

  const optionComments = existing !== undefined ? existing.optionComments : undefined;

  for (let i = 0; i < opts.length; i++) {
    const o = opts[i]!;
    const cursor = i === selectedAction ? `${CYAN}▸${RESET}` : ' ';
    const sc = o.shortcut === undefined ? ' ' : o.shortcut;
    const keyBadge = `${DIM}[${sc}]${RESET}`;
    const box = multi
      ? (checked.has(o.id) ? `${GREEN}[x]${RESET}` : `${DIM}[ ]${RESET}`) + ' '
      : '';

    const labelLines = wrap(sanitize(o.label), contentMax);
    for (let j = 0; j < labelLines.length; j++) {
      const prefix = j === 0 ? `  ${cursor} ${box}${keyBadge} ` : indent;
      lines.push(`${prefix}${labelLines[j]}`);
    }
    if (o.description) {
      const descLines = wrap(`— ${sanitize(o.description)}`, contentMax);
      for (const dl of descLines) {
        lines.push(`${indent}${DIM}${dl}${RESET}`);
      }
    }
    if (multi && optionComments !== undefined) {
      const note = optionComments[o.id];
      if (typeof note === 'string' && note.length > 0) {
        const noteLines = wrap(`✎ ${sanitize(note)}`, contentMax);
        for (const nl of noteLines) {
          lines.push(`${indent}${YELLOW}${nl}${RESET}`);
        }
      }
    }
  }

  if (interaction.allowFreetext && opts.length > 0) {
    const cursor = opts.length === selectedAction ? `${CYAN}▸${RESET}` : ' ';
    let label: string;
    if (interaction.freetextLabel !== undefined) label = interaction.freetextLabel;
    else if (multi) label = 'Add overall comment  (c on an option for per-option)';
    else label = 'Add comment';
    const ftLines = wrap(sanitize(label), contentMax);
    for (let j = 0; j < ftLines.length; j++) {
      const prefix = j === 0 ? `  ${cursor} ${DIM}[c]${RESET} ` : ' '.repeat(8);
      lines.push(`${prefix}${ftLines[j]}`);
    }
  } else if (interaction.allowFreetext && opts.length === 0) {
    const ftLabel = interaction.freetextLabel !== undefined ? interaction.freetextLabel : 'Enter response';
    const ftLines = wrap(sanitize(ftLabel), contentMax);
    for (let j = 0; j < ftLines.length; j++) {
      const prefix = j === 0 ? `  ${DIM}[r]${RESET} ` : ' '.repeat(6);
      lines.push(`${prefix}${ftLines[j]}`);
    }
  }

  if (existing) {
    lines.push('');
    for (const curLine of wrap(`Current: ${responseSummary(existing, interaction)}`, maxW)) {
      lines.push(`  ${GREEN}${curLine}${RESET}`);
    }
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
    const preAnswered = state.preAnsweredIds.has(interaction.id);
    const icon = response
      ? (preAnswered ? `${DIM}◆${RESET}` : `${GREEN}✓${RESET}`)
      : `${YELLOW}○${RESET}`;
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
  if (r.selectedOptionIds !== undefined) {
    const oc = r.optionComments;
    const parts = r.selectedOptionIds
      .map((id) => interaction.options.find((o) => o.id === id))
      .filter((o): o is NonNullable<typeof o> => o !== undefined)
      .map((o) => {
        const note = oc !== undefined ? oc[o.id] : undefined;
        return typeof note === 'string' && note.length > 0
          ? `${sanitize(o.label)} ("${sanitize(note)}")`
          : sanitize(o.label);
      });
    const picks = parts.length > 0 ? parts.join(', ') : '(none)';
    if (r.freetext) return `${picks}: "${sanitize(r.freetext)}"`;
    return picks;
  }
  const opt = r.selectedOptionId
    ? interaction.options.find((o) => o.id === r.selectedOptionId)
    : undefined;
  if (opt && r.freetext) return `${sanitize(opt.label)}: "${sanitize(r.freetext)}"`;
  if (opt) return sanitize(opt.label);
  if (r.freetext) return sanitize(r.freetext);
  return '(empty)';
}
