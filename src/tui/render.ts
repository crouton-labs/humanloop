import type { TuiState, Interaction, InteractionResponse } from '../types.js';
import { renderMarkdownBlockAwareLines } from '../render/termrender.js';
import {
  ESC, RESET, BOLD, DIM, ITALIC, GREEN, YELLOW, CYAN, REVERSE,
  sanitize, singleLine, truncate, hline, wrap, hardWrap, centerHorizontal, clipLine, panLine, visibleWidth,
} from './ansi.js';

/** Cells one h/l press pans by in the card body. */
const PAN_STEP = 8;

// ── Frame buffer ─────────────────────────────────────────────────────────────

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
  lines.push(`  ${DIM}enter${RESET} review  ${DIM}j/k${RESET} navigate  ${DIM}w${RESET} browser  ${DIM}q${RESET} finish`);

  while (lines.length < rows) lines.push('');
  // Overview content extends roughly cols-16 wide for option labels; center
  // against a 60-col cap (the divider width) when the terminal is much wider.
  const centered = centerHorizontal(lines.slice(0, rows), cols, Math.min(cols, 60) + 2);
  return centered;
}

/**
 * Render a (possibly multiline) input buffer with a visible cursor at
 * `cursor` (a code-point index). A private-use sentinel is inserted at the
 * cursor position, the result is hard-wrapped (so `\n` and width-wrapping
 * behave exactly as they would without a cursor), then the sentinel is
 * swapped for a reverse-video block on whichever wrapped line it landed on.
 * `stringWidth('\uE000') === 1`, so it occupies exactly one column and never
 * throws off the wrap math.
 */
export function renderInputBuffer(buffer: string, cursor: number, maxWidth: number): string[] {
  const chars = [...buffer];
  const at = Math.max(0, Math.min(cursor, chars.length));
  const withCaret = [...chars.slice(0, at), '\uE000', ...chars.slice(at)].join('');
  const wrapped = hardWrap(withCaret, maxWidth);
  return wrapped.map((line) => (
    line.includes('\uE000') ? line.replace('\uE000', `${REVERSE} ${RESET}`) : line
  ));
}

interface ItemReviewLayout {
  interaction: Interaction;
  preLines: string[];
  bodyLines: string[];
  postLines: string[];
  maxW: number;
  bodyHeight: number;
  maxScroll: number;
  overflows: boolean;
  /** Width of the rectangle body rows are painted into (including the 2-col
   *  left prefix). Equals the prose column unless a diagram claims the pane. */
  bodyBoxW: number;
  /** Cells the visible body can still pan right; 0 when nothing overflows. */
  maxHScroll: number;
}

/**
 * Build the item-review frame parts (pre/body/post) and derive the body's
 * scroll bounds. Pure: reads state, mutates nothing. Both `renderItemReview`
 * and the pre-render `clampItemReviewScroll` go through this, so the layout
 * math has a single source of truth.
 */
function buildItemReviewLayout(state: TuiState, cols: number, rows: number): ItemReviewLayout {
  const interaction = state.interactions[state.currentIndex]!;
  const visual = state.visuals.get(interaction.id);
  const response = state.responses.get(interaction.id);
  const maxW = Math.min(cols - 4, 120);
  // Diagrams are pictures, not prose: they render at the pane's full width
  // rather than the readability cap. The card stops being centered when one
  // claims that width, so the extra columns are actually available to it.
  const paneW = Math.max(20, cols - 4);
  const mdLines = (md: string): string[] => renderMarkdownBlockAwareLines(md, maxW, paneW);

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

  // Body: rendered subtitle + question body + expanded visual block (scrollable).
  // subtitle and body are both directive-flavored markdown rendered by termrender
  // and live in the scrollable region so long content never overflows the fixed
  // header — agents put rich prose in either field, so both must render markdown.
  const bodyLines: string[] = [];
  if (state.bodyMode === 'question') {
    if (interaction.subtitle) {
      bodyLines.push('');
      for (const line of mdLines(interaction.subtitle)) {
        bodyLines.push(`  ${line}`);
      }
    }
    if (interaction.body) {
      bodyLines.push('');
      for (const line of mdLines(interaction.body)) {
        bodyLines.push(`  ${line}`);
      }
    }
  }
  if (state.bodyMode === 'visual') {
    if (visual?.status === 'ready') {
      bodyLines.push('');
      bodyLines.push(`  ${DIM}── context ${hline(maxW - 12)}${RESET}`);
      // Keep the provider's original Markdown through layout. This is the
      // same block-aware contract as question/follow-up content: prose stays
      // readable while Mermaid uses the available pane width.
      for (const vl of visual.markdown === undefined ? visual.content.split('\n') : mdLines(visual.markdown)) {
        bodyLines.push(`  ${vl}`);
      }
      bodyLines.push(`  ${DIM}${hline(maxW)}${RESET}`);
    }
    if (state.followUp !== undefined && state.followUp.status !== 'idle') {
      bodyLines.push('');
      bodyLines.push(`  ${DIM}── follow-up ${hline(Math.max(0, maxW - 14))}${RESET}`);
      if (state.followUp.status === 'running') bodyLines.push(`  ${DIM}consulting…${RESET}`);
      else if (state.followUp.status === 'ready') {
        for (const line of mdLines(state.followUp.markdown)) bodyLines.push(`  ${line}`);
      } else bodyLines.push(`  ${YELLOW}${state.followUp.error}${RESET}`);
    }
  }

  // Post-body: visual status hint, input buffer or actions, footer (always visible)
  const postLines: string[] = [];
  postLines.push('');
  if (state.bodyMode === 'visual' && visual) {
    if (visual.status === 'loading') {
      postLines.push(`  ${DIM}loading context...${RESET}`);
      postLines.push('');
    } else if (visual.status === 'error') {
      postLines.push(`  ${YELLOW}visual context unavailable${RESET}`);
      postLines.push('');
    }
  }

  if (state.inputMode) {
    postLines.push(`  ${DIM}${hline(maxW)}${RESET}`);
    const label = state.inputMode.kind === 'follow-up'
      ? 'Ask a follow-up'
      : interaction.freetextLabel !== undefined
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
    const bufLines = renderInputBuffer(state.inputMode.buffer, state.inputMode.cursor, maxW - 1);
    for (const line of bufLines) postLines.push(`  ${line}`);
    if (attachedLine !== undefined) {
      postLines.push('');
      postLines.push(attachedLine);
    }
    postLines.push('');
    postLines.push(`  ${DIM}enter${RESET} submit  ${DIM}^J/⌥⏎${RESET} newline${state.editorAvailable ? `  ${DIM}^O${RESET} editor` : ''}  ${DIM}esc${RESET} cancel`);
  } else {
    postLines.push(...renderActions(interaction, state.selectedAction, maxW, response, state.followUp?.status !== 'running'));
  }

  // Transient hint (e.g. an empty multi-select Enter that was rejected). Sits
  // just above the footer; cleared on the next keypress.
  if (state.hint !== undefined && state.hint.length > 0) {
    postLines.push('');
    for (const hintLine of wrap(sanitize(state.hint), maxW)) {
      postLines.push(`  ${YELLOW}${hintLine}${RESET}`);
    }
  }

  // Derive the scroll window bounds. This builder never writes back into state
  // — the host clamps state.scrollOffset via clampItemReviewScroll before render.
  const reservedRows = preLines.length + postLines.length + 1; // +1 for footer
  const bodyHeight = Math.max(1, rows - reservedRows);
  const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
  const overflows = bodyLines.length > bodyHeight;

  // Horizontal geometry, derived from what is actually on screen: a body row
  // wider than the prose column takes the whole pane (which also drops the
  // centering pad below), and anything past that pans.
  const scroll = Math.max(0, Math.min(state.scrollOffset || 0, maxScroll));
  const visible = visibleItemBodyLines(bodyLines, scroll, bodyHeight);
  let widest = 0;
  for (const line of visible) widest = Math.max(widest, visibleWidth(line));
  const bodyBoxW = widest > maxW + 2 ? paneW + 2 : maxW + 2;
  return {
    interaction, preLines, bodyLines, postLines,
    maxW, bodyHeight, maxScroll, overflows,
    bodyBoxW, maxHScroll: Math.max(0, widest - bodyBoxW),
  };
}

/** Body rows as they are actually painted: vertical-scroll indicators replace
 * their endpoint rows, so those hidden rows cannot make h/l available. */
function visibleItemBodyLines(bodyLines: string[], scroll: number, bodyHeight: number): string[] {
  if (bodyLines.length <= bodyHeight) return bodyLines;
  const visible = bodyLines.slice(scroll, scroll + bodyHeight);
  if (scroll > 0) visible[0] = `  ${DIM}↑ ${scroll} more above${RESET}`;
  const remainingBelow = bodyLines.length - (scroll + bodyHeight);
  if (remainingBelow > 0) visible[visible.length - 1] = `  ${DIM}↓ ${remainingBelow} more below${RESET}`;
  return visible;
}

/**
 * Clamp state.scrollOffset to the current body's scroll bounds. The host runs
 * this as a pre-render step (from the input path) so `renderItemReview` stays a
 * pure function of state — the clamp keeps u/d scrolling responsive without the
 * renderer mutating state mid-frame.
 */
export function clampItemReviewScroll(state: TuiState, cols: number, rows: number): void {
  const { maxScroll, maxHScroll } = buildItemReviewLayout(state, cols, rows);
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset || 0, maxScroll));
  state.bodyScrollOffsets[state.bodyMode] = state.scrollOffset;
  // Publish the live horizontal reach so the input layer can tell whether h/l
  // mean "pan" on this card, and keep the stored pan inside it across vertical
  // scrolling and resize.
  state.hscrollMax = maxHScroll;
  state.hscrollOffset = Math.max(0, Math.min(state.hscrollOffset || 0, maxHScroll));
}

/** Pan the card body horizontally. Clamping happens in the pre-render clamp
 *  the host already runs, exactly like vertical over-scroll. */
export function panItemReview(state: TuiState, direction: -1 | 1): void {
  state.hscrollOffset = Math.max(0, (state.hscrollOffset || 0) + direction * PAN_STEP);
}

export function renderItemReview(state: TuiState, cols: number, rows: number): string[] {
  const { interaction, preLines, bodyLines, postLines, maxW, bodyHeight, maxScroll, overflows, bodyBoxW, maxHScroll } =
    buildItemReviewLayout(state, cols, rows);
  // Read-only clamp: renderer never mutates state (clampItemReviewScroll, run
  // pre-render, keeps state.scrollOffset itself in bounds).
  const scroll = Math.max(0, Math.min(state.scrollOffset || 0, maxScroll));

  let visibleBody = visibleItemBodyLines(bodyLines, scroll, bodyHeight);
  // Contain every body row in the card's rectangle: rows that fit are
  // untouched, a diagram wider than the pane pans under h/l with ‹/› marking
  // the content still off-screen.
  const hscroll = Math.max(0, Math.min(state.hscrollOffset || 0, maxHScroll));
  visibleBody = visibleBody.map((line) => panLine(line, hscroll, bodyBoxW));

  // Footer hint — mention scroll keys when body overflows
  const footerParts = interaction.multiSelect === true
    ? [
        `${DIM}n/p${RESET} prev/next`,
        `${DIM}space${RESET} toggle`,
        `${DIM}enter${RESET} confirm`,
        `${DIM}shift-tab${RESET} ${state.bodyMode === 'question' ? 'visual' : 'question'}`,
        `${DIM}q${RESET} overview`,
      ]
    : [
        `${DIM}n/p${RESET} prev/next`,
        `${DIM}shift-tab${RESET} ${state.bodyMode === 'question' ? 'visual' : 'question'}`,
        `${DIM}q${RESET} overview`,
      ];
  if (overflows) {
    footerParts.unshift(state.inputMode ? `${DIM}pgup/pgdn${RESET} scroll` : `${DIM}u/d${RESET} scroll`);
  }
  if (maxHScroll > 0 && state.inputMode === null) {
    footerParts.unshift(`${DIM}h/l${RESET} pan`);
  }
  if (state.inputMode === null) {
    if (state.followUpAvailable) footerParts.push(`${DIM}?${RESET} follow-up`);
    footerParts.push(`${DIM}w${RESET} browser`);
  }
  const footer = `  ${footerParts.join('  ')}`;

  // Assemble — pad to fill rows so post-body sits at the bottom
  const lines: string[] = [...preLines, ...visibleBody, ...postLines];
  while (lines.length < rows - 1) lines.push('');
  lines.push(footer);

  // Final clamp (safety net for very small terminals)
  const clamped = lines.length > rows
    ? [...lines.slice(0, rows - 1), footer]
    : lines;
  // Content occupies the body rectangle (prose column, or the full pane when a
  // diagram claims it) — center the whole block when the terminal is wider,
  // then contain every row so nothing can wrap past the card's rectangle.
  return centerHorizontal(clamped, cols, bodyBoxW).map((line) => clipLine(line, cols));
}

function renderActions(
  interaction: Interaction,
  selectedAction: number,
  maxW: number,
  existing?: InteractionResponse,
  showFocus = true,
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
    const cursor = showFocus && i === selectedAction ? `${CYAN}▸${RESET}` : ' ';
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
    const cursor = showFocus && opts.length === selectedAction ? `${CYAN}▸${RESET}` : ' ';
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

/**
 * Rendered while the deck panel has handed control to the browser (see the
 * `w` handoff in `resolveInteractionDir`). Purely informational — no keys are
 * routed to the panel while this is on screen; the host intercepts the
 * take-back key itself.
 */
export function renderHandoff(url: string, cols: number, rows: number): string[] {
  const maxW = Math.min(cols - 4, 68);
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${BOLD}${CYAN} Handed off to the browser ${RESET}`);
  lines.push(`  ${DIM}${hline(maxW)}${RESET}`);
  lines.push('');
  lines.push(`  ${DIM}Open (or already opened):${RESET}`);
  lines.push(`  ${CYAN}${truncate(url, maxW)}${RESET}`);
  lines.push('');
  lines.push(`  ${ITALIC}${DIM}The browser is the sole editor now — submit there.${RESET}`);
  lines.push(`  ${ITALIC}${DIM}This pane will converge automatically once it submits.${RESET}`);
  lines.push('');
  lines.push(`  ${DIM}${hline(maxW)}${RESET}`);
  lines.push(`  ${YELLOW}w${RESET} take back control`);
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
