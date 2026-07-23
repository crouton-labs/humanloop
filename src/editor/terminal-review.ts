import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import stringWidth from 'string-width';
import type { FeedbackComment, FeedbackResult } from '../types.js';
import type { ReviewOptions } from './review.js';
import { waitForParkedReviewSubmit } from './parked.js';
import { openBrowser } from '../browser/open.js';
import { startReviewWebServer } from '../browser/server.js';
import { buildDraftFeedbackResult, buildFinalFeedbackResult, readReviewDraft, writeReviewDraft } from './feedback.js';
import { renderMarkdownWithMap, type RenderedDoc } from '../render/termrender.js';
import { setupTerminal, restoreTerminal, getTerminalSize, parseKeypress, type Key } from '../tui/terminal.js';
import { diffFrame, renderInputBuffer } from '../tui/render.js';
import { BOLD, CYAN, DIM, ESC, RESET, YELLOW, hline, sanitize, truncate } from '../tui/ansi.js';

// ── Pure state ───────────────────────────────────────────────────────────────
// The document is the cursor: the anchor is a leaf unit of the rendered
// document (a bullet, a table row, a code line, a paragraph, a whole
// diagram…), highlighted in place via termrender's per-row source spans.
// Comments still record precise source `line`/`endLine`/`lineText` (from the
// anchored units' source ranges), so the FeedbackComment schema is unchanged.

/** One leaf anchor unit: the finest step j/k moves by. Consecutive rendered
 *  rows sharing one source span collapse into a single unit that knows both
 *  its source-line bounds and its rendered-row bounds. */
export interface AnchorUnit {
  /** 1-indexed inclusive source-line bounds. */
  start: number;
  end: number;
  /** 0-indexed inclusive rendered-row bounds in the mapped doc. */
  firstRow: number;
  lastRow: number;
}

/** The anchorable shape of a rendered doc: ordered leaf units plus the
 *  per-row owning-unit index the painter keys off. */
export interface AnchorDoc {
  units: AnchorUnit[];
  /** Per rendered row: index into `units`, or null (separator rows). */
  rowUnits: (number | null)[];
}

/** Derive leaf anchor units from a mapped render: dedupe runs of consecutive
 *  rows carrying the identical source span. A mapped row without a leaf span
 *  (an unmapped block) anchors at its whole block's range, so every content
 *  row belongs to a unit; separator rows belong to none. */
export function deriveAnchorUnits(doc: RenderedDoc): AnchorDoc {
  const units: AnchorUnit[] = [];
  const rowUnits: (number | null)[] = new Array<number | null>(doc.lines.length).fill(null);
  for (let r = 0; r < doc.lines.length; r++) {
    let span = doc.spans[r] ?? null;
    if (span === null) {
      const b = doc.rows[r] ?? null;
      const block = b !== null ? doc.blocks[b] : undefined;
      if (block === undefined) continue;
      span = [block.start, block.end];
    }
    const prev = units[units.length - 1];
    if (prev !== undefined && prev.lastRow === r - 1 && prev.start === span[0] && prev.end === span[1]) {
      prev.lastRow = r;
    } else {
      units.push({ start: span[0], end: span[1], firstRow: r, lastRow: r });
    }
    rowUnits[r] = units.length - 1;
  }
  if (units.length === 0) {
    // Degenerate map (nothing anchorable) — one whole-doc unit over all rows.
    units.push({
      start: doc.blocks[0]?.start ?? 1,
      end: doc.blocks[doc.blocks.length - 1]?.end ?? 1,
      firstRow: 0,
      lastRow: Math.max(0, doc.lines.length - 1),
    });
    for (let r = 0; r < rowUnits.length; r++) rowUnits[r] = 0;
  }
  return { units, rowUnits };
}

export interface ComposeState {
  buffer: string;
  cursor: number;
  /** Id of the comment being edited, or null when composing a new comment. */
  editingId: string | null;
  /** Submode to return to once compose closes (Escape or a successful save). */
  returnMode: 'view' | 'list';
  anchor: { line: number; endLine: number };
}

export interface ReviewState {
  sourceLines: string[];
  /** Ordered leaf anchor units. Never empty. */
  units: AnchorUnit[];
  /** Per rendered row: owning unit index, or null for separator rows. */
  rowUnits: (number | null)[];
  comments: FeedbackComment[];
  version: number;
  /** 0-based index of the anchored unit. */
  activeUnit: number;
  /** Set while a Shift+j/k range is being extended from this unit. */
  selectionAnchor: number | null;
  /** Scroll offset into the rendered (termrender) lines. */
  scroll: number;
  mode: 'view' | 'list' | 'compose' | 'help';
  compose: ComposeState | null;
  listIndex: number;
}

/** Best unit for a source line: the NARROWEST unit containing it — code/table
 *  chrome units carry their whole block's range and sit before the per-line
 *  content units in rendered order, so "first whose end reaches the line"
 *  would wrongly pick the chrome over the exact code line. A line no unit
 *  contains (a blank separator) snaps forward to the next unit; past the end
 *  clamps to the last. */
export function unitIndexForLine(units: AnchorUnit[], line: number): number {
  let best = -1;
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (u.start <= line && u.end >= line) {
      if (best === -1 || u.end - u.start < units[best]!.end - units[best]!.start) best = i;
    }
  }
  if (best !== -1) return best;
  for (let i = 0; i < units.length; i++) {
    if (units[i]!.start > line) return i;
  }
  return Math.max(0, units.length - 1);
}

/** Remap a unit from an old unit list into a re-derived one: an exact
 *  source-range match wins (chrome and leaf units can share source lines),
 *  else the best unit for its first line. */
export function remapUnitIndex(units: AnchorUnit[], prev: AnchorUnit): number {
  for (let i = 0; i < units.length; i++) {
    if (units[i]!.start === prev.start && units[i]!.end === prev.end) return i;
  }
  return unitIndexForLine(units, prev.start);
}

/** First/last unit indices overlapping the source range `line..endLine`;
 *  a range touching no unit snaps like unitIndexForLine. */
export function unitRangeForSpan(units: AnchorUnit[], line: number, endLine: number): { lo: number; hi: number } {
  let lo = -1;
  let hi = -1;
  units.forEach((u, i) => {
    if (u.start <= endLine && u.end >= line) {
      if (lo === -1) lo = i;
      hi = i;
    }
  });
  if (lo === -1) {
    const snap = unitIndexForLine(units, line);
    return { lo: snap, hi: snap };
  }
  return { lo, hi };
}

export function initReviewState(sourceLines: string[], anchor: AnchorDoc, comments: FeedbackComment[], version: number): ReviewState {
  const safe = anchor.units.length > 0
    ? anchor
    : { units: [{ start: 1, end: Math.max(1, sourceLines.length), firstRow: 0, lastRow: 0 }], rowUnits: anchor.rowUnits };
  return {
    sourceLines,
    units: safe.units,
    rowUnits: safe.rowUnits,
    comments: [...comments],
    version,
    activeUnit: comments.length > 0 ? unitIndexForLine(safe.units, comments[0]!.line) : 0,
    selectionAnchor: null,
    scroll: 0,
    mode: 'view',
    compose: null,
    listIndex: 0,
  };
}

function selectedUnitBounds(state: ReviewState): { lo: number; hi: number } {
  const sel = state.selectionAnchor ?? state.activeUnit;
  return { lo: Math.min(state.activeUnit, sel), hi: Math.max(state.activeUnit, sel) };
}

/** Source-line anchor of the current unit selection — what a committed
 *  comment records as `line`/`endLine`. Whole-block chrome units can carry a
 *  wider range than their neighbors, so take the min/max over the selection
 *  rather than trusting the endpoints alone. */
export function currentAnchor(state: ReviewState): { line: number; endLine: number } {
  const { lo, hi } = selectedUnitBounds(state);
  let line = Number.POSITIVE_INFINITY;
  let endLine = 0;
  for (let i = lo; i <= hi; i++) {
    const u = state.units[i];
    if (u === undefined) continue;
    line = Math.min(line, u.start);
    endLine = Math.max(endLine, u.end);
  }
  if (!Number.isFinite(line)) return { line: 1, endLine: Math.max(1, state.sourceLines.length) };
  return { line, endLine: Math.max(line, endLine) };
}

export function moveActiveUnit(state: ReviewState, delta: number, extend: boolean): ReviewState {
  const last = Math.max(0, state.units.length - 1);
  const next = Math.max(0, Math.min(last, state.activeUnit + delta));
  if (!extend) return { ...state, activeUnit: next, selectionAnchor: null };
  return { ...state, activeUnit: next, selectionAnchor: state.selectionAnchor ?? state.activeUnit };
}

/** Unit indices overlapped by any existing comment's source range. A stale
 *  draft range lying wholly past the last unit (the file shrank between draft
 *  save and reopen) still gets a marker on its clamped unit, so every comment
 *  is visible somewhere in the document. */
export function commentedUnitSet(state: ReviewState): Set<number> {
  const out = new Set<number>();
  for (const c of state.comments) {
    let hit = false;
    state.units.forEach((u, i) => {
      if (u.start <= c.endLine && u.end >= c.line) {
        out.add(i);
        hit = true;
      }
    });
    if (!hit) out.add(unitIndexForLine(state.units, c.line));
  }
  return out;
}

/** First/last rendered-row indices spanned by units `lo..hi`, or null when
 *  the indices fall outside the unit list. */
export function anchorRowRange(units: AnchorUnit[], lo: number, hi: number): { first: number; last: number } | null {
  const a = units[lo];
  const b = units[hi];
  if (a === undefined || b === undefined) return null;
  return { first: a.firstRow, last: b.lastRow };
}

/** Minimal scroll adjustment that keeps rows `first..last` visible with
 *  `margin` rows of context (the margin yields whenever honoring it would push
 *  either edge of the span out of view); a taller-than-view span pins `first`
 *  at the top — one row down when scrolled, so the `↑ more above` indicator
 *  overwrites the preceding row, never the pinned one. Always returns a scroll
 *  clamped to the document. */
export function scrollToReveal(scroll: number, first: number, last: number, bodyHeight: number, total: number, margin = 2): number {
  const maxScroll = Math.max(0, total - bodyHeight);
  let next = Math.max(0, Math.min(scroll, maxScroll));
  if (last - first + 1 >= bodyHeight) return Math.max(0, Math.min(Math.max(0, first - 1), maxScroll));
  if (first - margin < next) next = Math.max(first - margin, last - (bodyHeight - 1));
  else if (last + margin > next + bodyHeight - 1) next = Math.min(last + margin - (bodyHeight - 1), first);
  return Math.max(0, Math.min(next, maxScroll));
}

/** Auto-scroll so the active unit (the moving edge of a selection) is
 *  visible. Free-scrolling (`u`/`d`) is untouched until the next anchor move. */
export function ensureAnchorVisible(state: ReviewState, doc: RenderedDoc, bodyHeight: number): ReviewState {
  const range = anchorRowRange(state.units, state.activeUnit, state.activeUnit);
  if (range === null) return state;
  const scroll = scrollToReveal(state.scroll, range.first, range.last, bodyHeight, doc.lines.length);
  return scroll === state.scroll ? state : { ...state, scroll };
}

export function scrollBy(state: ReviewState, delta: number, bodyHeight: number, totalLines: number): ReviewState {
  const maxScroll = Math.max(0, totalLines - bodyHeight);
  return { ...state, scroll: Math.max(0, Math.min(state.scroll + delta, maxScroll)) };
}

export function openComposeNew(state: ReviewState): ReviewState {
  return { ...state, mode: 'compose', compose: { buffer: '', cursor: 0, editingId: null, returnMode: 'view', anchor: currentAnchor(state) } };
}

export function openComposeEdit(state: ReviewState, index: number): ReviewState {
  const comment = state.comments[index];
  if (comment === undefined) return state;
  const buffer = comment.comment;
  const { lo, hi } = unitRangeForSpan(state.units, comment.line, comment.endLine);
  return {
    ...state,
    activeUnit: hi,
    selectionAnchor: lo === hi ? null : lo,
    mode: 'compose',
    compose: { buffer, cursor: [...buffer].length, editingId: comment.id, returnMode: 'list', anchor: { line: comment.line, endLine: comment.endLine } },
  };
}

export function closeCompose(state: ReviewState): ReviewState {
  const returnMode = state.compose?.returnMode ?? 'view';
  return { ...state, mode: returnMode, compose: null };
}

/** Commits the current compose buffer as a new comment or an edit to an existing one. Empty text cancels. */
export function commitCompose(state: ReviewState, now = new Date().toISOString()): ReviewState {
  const c = state.compose;
  if (c === null || c === undefined) return state;
  const text = c.buffer.trim();
  if (text.length === 0) return closeCompose(state);
  if (c.editingId !== null) {
    const comments = state.comments.map((cm) => (cm.id === c.editingId ? { ...cm, comment: text } : cm));
    return { ...state, comments, mode: c.returnMode, compose: null };
  }
  const lineText = state.sourceLines.slice(c.anchor.line - 1, c.anchor.endLine).join('\n');
  const comment: FeedbackComment = { id: randomUUID(), line: c.anchor.line, endLine: c.anchor.endLine, lineText, comment: text, createdAt: now };
  return { ...state, comments: [...state.comments, comment], mode: c.returnMode, compose: null };
}

export function openList(state: ReviewState): ReviewState {
  return { ...state, mode: 'list', listIndex: Math.max(0, Math.min(state.listIndex, state.comments.length - 1)) };
}

export function closeList(state: ReviewState): ReviewState {
  return { ...state, mode: 'view' };
}

export function moveListIndex(state: ReviewState, delta: number): ReviewState {
  if (state.comments.length === 0) return state;
  const next = Math.max(0, Math.min(state.comments.length - 1, state.listIndex + delta));
  return { ...state, listIndex: next };
}

export function deleteAtListIndex(state: ReviewState): ReviewState {
  if (state.comments.length === 0) return state;
  const comments = state.comments.filter((_, i) => i !== state.listIndex);
  const listIndex = Math.max(0, Math.min(state.listIndex, comments.length - 1));
  return { ...state, comments, listIndex };
}

export function undoLast(state: ReviewState): ReviewState {
  if (state.comments.length === 0) return state;
  return { ...state, comments: state.comments.slice(0, -1) };
}

export function openHelp(state: ReviewState): ReviewState {
  return { ...state, mode: 'help' };
}

export function closeHelp(state: ReviewState): ReviewState {
  return { ...state, mode: 'view' };
}

// ── Multi-line text-buffer helpers (flat string + code-point cursor) ────────

function codePoints(s: string): string[] {
  return [...s];
}

// A single physical keypress (including Enter) almost always arrives as its
// own 'data' event, so parseKeypress's per-event key flags cover the normal
// typing path. A chunk longer than one character is a paste (or, rarely,
// several keystrokes the OS coalesced into one read) and is never re-parsed
// for key semantics — an embedded CR there means a pasted newline, not a
// commit. Mirrors tui/input.ts's paste cleaning: strip escape sequences,
// normalize CR/CRLF to LF, drop remaining control bytes, keep LF.
function cleanPastedText(input: string): string {
  return input
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
}

export function textInsert(buffer: string, cursor: number, text: string): { buffer: string; cursor: number } {
  const chars = codePoints(buffer);
  const at = Math.max(0, Math.min(cursor, chars.length));
  const next = [...chars.slice(0, at), ...codePoints(text), ...chars.slice(at)].join('');
  return { buffer: next, cursor: at + codePoints(text).length };
}

export function textBackspace(buffer: string, cursor: number): { buffer: string; cursor: number } {
  if (cursor <= 0) return { buffer, cursor };
  const chars = codePoints(buffer);
  return { buffer: [...chars.slice(0, cursor - 1), ...chars.slice(cursor)].join(''), cursor: cursor - 1 };
}

export function textDelete(buffer: string, cursor: number): { buffer: string; cursor: number } {
  const chars = codePoints(buffer);
  if (cursor >= chars.length) return { buffer, cursor };
  return { buffer: [...chars.slice(0, cursor), ...chars.slice(cursor + 1)].join(''), cursor };
}

function lineBoundsAt(chars: string[], cursor: number): { start: number; end: number } {
  let start = cursor;
  while (start > 0 && chars[start - 1] !== '\n') start--;
  let end = cursor;
  while (end < chars.length && chars[end] !== '\n') end++;
  return { start, end };
}

export function textHome(buffer: string, cursor: number): number {
  return lineBoundsAt(codePoints(buffer), cursor).start;
}

export function textEnd(buffer: string, cursor: number): number {
  return lineBoundsAt(codePoints(buffer), cursor).end;
}

export function textVertical(buffer: string, cursor: number, delta: number): number {
  const chars = codePoints(buffer);
  const { start, end } = lineBoundsAt(chars, cursor);
  const col = cursor - start;
  if (delta < 0) {
    if (start === 0) return cursor;
    const prevEnd = start - 1; // the '\n' just before this line
    const prevStart = lineBoundsAt(chars, prevEnd).start;
    return Math.min(prevEnd, prevStart + col);
  }
  if (end >= chars.length) return cursor;
  const nextStart = end + 1;
  const nextEnd = lineBoundsAt(chars, nextStart).end;
  return Math.min(nextEnd, nextStart + col);
}

// ── Rendering (pure) ─────────────────────────────────────────────────────────

/** Width the document is rendered at for a given terminal width: 2-col left
 *  margin + 2-col gutter before the content, capped for readability. */
export function renderWidthForCols(cols: number): number {
  return Math.min(Math.max(20, cols - 6), 120);
}

// Single-hue anchor tint (a dark neutral step below the CYAN gutter bar).
// termrender's only reset is `\x1b[0m`, so re-arming the background after each
// reset keeps the tint alive across inner styling. Heading rows carry their
// own background and won't show the tint — the gutter bar still marks them.
const TINT_BG = `${ESC}48;5;236m`;

function tintRow(row: string, width: number): string {
  const pad = Math.max(0, width - stringWidth(sanitize(row)));
  return TINT_BG + row.replaceAll(RESET, RESET + TINT_BG) + ' '.repeat(pad) + RESET;
}

/** Reserved (non-body) rows for each mode's fixed header/footer chrome. Kept in
 *  sync with renderReviewFrame so scroll math can clamp before a repaint — the
 *  compose case counts the same hard-wrapped input lines the frame renders. */
export function reservedRows(state: ReviewState, cols: number): number {
  const header = 3; // blank, title, divider
  if (state.mode === 'view') return header + 1;
  if (state.mode === 'compose') {
    const c = state.compose;
    const maxW = Math.min(Math.max(20, cols - 4), 120);
    const bufLines = c ? renderInputBuffer(c.buffer, c.cursor, Math.max(10, maxW - 2)).length : 1;
    return header + 3 + bufLines;
  }
  if (state.mode === 'list') return header + Math.max(1, state.comments.length) + 2;
  return header + 9; // help
}

export function renderReviewFrame(state: ReviewState, fileLabel: string, doc: RenderedDoc, cols: number, rows: number): string[] {
  const maxW = Math.min(Math.max(20, cols - 4), 120);
  const docW = renderWidthForCols(cols);
  const header: string[] = [
    '',
    `  ${BOLD}${CYAN}Review — ${fileLabel}${RESET}  ${DIM}${state.comments.length} comment${state.comments.length === 1 ? '' : 's'}${RESET}`,
    `  ${DIM}${hline(maxW)}${RESET}`,
  ];

  const footer: string[] = [];
  if (state.mode === 'compose' && state.compose) {
    const c = state.compose;
    const label = c.anchor.line === c.anchor.endLine ? `L${c.anchor.line}` : `L${c.anchor.line}-${c.anchor.endLine}`;
    footer.push(`  ${YELLOW}${c.editingId !== null ? 'Edit comment' : 'Comment'} on ${label}:${RESET}`);
    for (const l of renderInputBuffer(c.buffer, c.cursor, Math.max(10, maxW - 2))) footer.push(`  ${l}`);
    footer.push('');
    footer.push(`  ${DIM}enter${RESET} save  ${DIM}^J/⌥⏎${RESET} newline  ${DIM}esc${RESET} cancel`);
  } else if (state.mode === 'list') {
    if (state.comments.length === 0) {
      footer.push(`  ${DIM}(no comments yet — space c to add one)${RESET}`);
    } else {
      state.comments.forEach((c, i) => {
        const loc = c.line === c.endLine ? `L${c.line}` : `L${c.line}-${c.endLine}`;
        const cursor = i === state.listIndex ? `${CYAN}▸${RESET}` : ' ';
        const text = truncate(c.comment.replace(/\n/g, ' / '), Math.max(10, maxW - 14));
        footer.push(`  ${cursor} ${DIM}[${loc}]${RESET} ${text}`);
      });
    }
    footer.push('');
    footer.push(`  ${DIM}j/k${RESET} move  ${DIM}enter/e${RESET} edit  ${DIM}d${RESET} delete  ${DIM}q/esc${RESET} close`);
  } else if (state.mode === 'help') {
    footer.push('  Keys:');
    footer.push(`  ${DIM}j/k${RESET}         move anchor            ${DIM}shift+j/k${RESET}   extend selection`);
    footer.push(`  ${DIM}u/d, pgup/pgdn${RESET}  scroll document`);
    footer.push(`  ${DIM}space c${RESET}     compose comment        ${DIM}space l${RESET}     list comments`);
    footer.push(`  ${DIM}space u${RESET}     undo last comment      ${DIM}space s${RESET}     submit review`);
    footer.push(`  ${DIM}space w${RESET}     hand off to browser`);
    footer.push(`  ${DIM}?${RESET}           toggle this help       ${DIM}esc${RESET}         close/cancel`);
    footer.push('');
    footer.push(`  ${DIM}esc / ?${RESET} close`);
  } else {
    footer.push(
      `  ${DIM}j/k${RESET} move  ${DIM}shift-j/k${RESET} extend  ${DIM}u/d${RESET} scroll  ${DIM}space c${RESET} comment  ` +
      `${DIM}space l${RESET} list  ${DIM}space u${RESET} undo  ${DIM}space s${RESET} submit  ${DIM}space w${RESET} browser  ${DIM}?${RESET} help  ${DIM}esc${RESET} close`,
    );
  }

  const reserved = header.length + footer.length;
  const bodyHeight = Math.max(1, rows - reserved);
  const maxScroll = Math.max(0, doc.lines.length - bodyHeight);
  const scroll = Math.max(0, Math.min(state.scroll, maxScroll));
  const { lo, hi } = selectedUnitBounds(state);
  const commented = commentedUnitSet(state);
  const body: string[] = [];
  for (let i = 0; i < bodyHeight; i++) {
    const abs = scroll + i;
    if (abs >= doc.lines.length) {
      body.push('');
      continue;
    }
    const row = doc.lines[abs]!;
    const u = state.rowUnits[abs] ?? null;
    if (u !== null && u >= lo && u <= hi) body.push(`  ${CYAN}▌${RESET} ${tintRow(row, docW)}`);
    else if (u !== null && commented.has(u)) body.push(`  ${YELLOW}▎${RESET} ${row}`);
    else body.push(`    ${row}`);
  }
  if (scroll > 0 && body.length > 0) body[0] = `  ${DIM}↑ ${scroll} more above${RESET}`;
  const remaining = doc.lines.length - (scroll + bodyHeight);
  if (remaining > 0 && body.length > 0) body[body.length - 1] = `  ${DIM}↓ ${remaining} more below${RESET}`;
  while (body.length < bodyHeight) body.push('');

  const lines = [...header, ...body, ...footer];
  while (lines.length < rows) lines.push('');
  return lines.slice(0, rows);
}

// ── Host loop (impure — the only part that touches the real TTY) ───────────

/** How one TUI session ended: a final result, or a request to hand the review
 *  off to the browser (terminal restored, draft persisted). */
type SessionOutcome = { type: 'done'; result: FeedbackResult } | { type: 'handoff' };

function diskDraftResult(absFile: string, outPath: string): FeedbackResult {
  const draft = readReviewDraft(outPath);
  return buildDraftFeedbackResult(absFile, draft?.comments ?? [], draft?.savedAt);
}

/**
 * Open a Markdown file in humanloop's own terminal review surface: the
 * document renders via termrender (Mermaid included), the anchor is a
 * highlighted leaf unit — a bullet, table row, code line, paragraph — in the
 * rendered document itself (gutter bar + tint via termrender's per-row source
 * spans), and the human explicitly submits a proposal.
 * `space w` hands the review off to the browser surface (same park/take-back
 * semantics as the Neovim path); the draft round-trips between surfaces via
 * `opts.output`. Never edits the source file. Autosaves the comment draft to
 * `opts.output` (the `progress.json` convention). Canonical ticket
 * finalization stays with the caller's `onPropose` (the adapter calls
 * `completeReview`); this function never writes `response.json`.
 */
export async function launchTerminalReview(file: string, opts: ReviewOptions): Promise<FeedbackResult> {
  const absFile = resolve(file);
  const content = readFileSync(absFile, 'utf8');
  const outPath = resolve(opts.output);
  const fileLabel = basename(absFile);
  // Created lazily on the first browser handoff, reused across take-backs.
  let jobDir: string | null = opts.jobDir ?? null;

  while (true) {
    if (opts.signal?.aborted) return diskDraftResult(absFile, outPath);
    const outcome = await runTerminalReviewSession(absFile, content, outPath, fileLabel, opts);
    if (outcome.type === 'done') return outcome.result;

    // Browser handoff: the TUI is parked (terminal already restored, draft
    // persisted); the browser is the editing authority until it submits, the
    // human takes back with `w`, or the review is cancelled.
    if (jobDir === null) jobDir = mkdtempSync(join(tmpdir(), 'hl-review-'));
    let resolveSubmitted!: (result: FeedbackResult) => void;
    const submitted = new Promise<FeedbackResult>((resolveSubmittedPromise) => {
      resolveSubmitted = resolveSubmittedPromise;
    });
    const server = await startReviewWebServer({
      jobDir,
      file: absFile,
      output: outPath,
      onSubmit: (result) => resolveSubmitted(result),
    });
    if (opts.signal?.aborted) {
      await server.stop();
      return diskDraftResult(absFile, outPath);
    }
    server.activate();
    process.stderr.write(`humanloop: browser review handoff active — ${server.url}\n`);
    openBrowser(server.url);
    const action = await waitForParkedReviewSubmit(submitted, opts.signal, 'the terminal review');
    if (action.type === 'submitted') {
      await server.stop();
      // An abort landing during the async stop() must not produce a submitted
      // result whose canonical onPropose convergence was skipped — fall back
      // to the disk draft (the browser submit already persisted its comments).
      if (opts.signal?.aborted) return diskDraftResult(absFile, outPath);
      await opts.onPropose?.(action.result);
      return action.result;
    }
    if (action.type === 'take-back') {
      await server.requestTakeBack();
      await server.stop();
      process.stderr.write('humanloop: taking review back into the terminal review.\n');
      continue; // re-enter the TUI; the next session re-reads the draft from disk
    }
    await server.stop();
    return diskDraftResult(absFile, outPath);
  }
}

/** One TUI session over the document. Resolves when the review reaches a
 *  final result (submit/close/cancel) or the human requests browser handoff;
 *  either way the terminal is restored before resolution. Re-reads the draft
 *  from disk on entry so browser edits survive a take-back. */
function runTerminalReviewSession(absFile: string, content: string, outPath: string, fileLabel: string, opts: ReviewOptions): Promise<SessionOutcome> {
  const sourceLines = content.split('\n');
  const draft = readReviewDraft(outPath);

  setupTerminal();
  let { cols, rows } = getTerminalSize();
  let doc = renderMarkdownWithMap(content, renderWidthForCols(cols));
  let state = initReviewState(sourceLines, deriveAnchorUnits(doc), draft?.comments ?? [], draft?.version ?? 0);
  let prevFrame: string[] = [];
  let spaceArmed = false;
  let settled = false;

  const bodyH = (): number => Math.max(1, rows - reservedRows(state, cols));
  state = ensureAnchorVisible(state, doc, bodyH());

  return new Promise<SessionOutcome>((resolvePromise) => {
    const persist = (): void => {
      state = { ...state, version: state.version + 1 };
      writeReviewDraft(outPath, state.comments, state.version);
    };

    const paint = (clear = false): void => {
      const lines = renderReviewFrame(state, fileLabel, doc, cols, rows);
      if (clear) {
        prevFrame = [];
        process.stdout.write('\x1b[2J\x1b[H');
      }
      const { writes, nextPrevFrame } = diffFrame(prevFrame, lines, rows, cols);
      process.stdout.write('\x1b[?2026h');
      for (const w of writes) process.stdout.write(w);
      process.stdout.write('\x1b[?2026l');
      prevFrame = nextPrevFrame;
    };

    const finishWith = (outcome: SessionOutcome): void => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', onResize);
      opts.signal?.removeEventListener('abort', onAbort);
      restoreTerminal();
      resolvePromise(outcome);
    };

    const finish = (result: FeedbackResult): void => finishWith({ type: 'done', result });

    const onResize = (): void => {
      ({ cols, rows } = getTerminalSize());
      doc = renderMarkdownWithMap(content, renderWidthForCols(cols));
      // Unit SOURCE ranges are width-independent under the same renderer (only
      // their rendered-row bounds move), but a mid-session renderer→fallback
      // transition can reshape the list — so remap the anchor by its source
      // line rather than trusting the old index. Committed comments are
      // untouched either way (their source lines are frozen).
      const prevActive = state.units[state.activeUnit];
      const prevSel = state.selectionAnchor !== null ? state.units[state.selectionAnchor] : undefined;
      const { units, rowUnits } = deriveAnchorUnits(doc);
      state = {
        ...state,
        units,
        rowUnits,
        activeUnit: prevActive !== undefined ? remapUnitIndex(units, prevActive) : 0,
        selectionAnchor: prevSel !== undefined ? remapUnitIndex(units, prevSel) : null,
      };
      state = ensureAnchorVisible(state, doc, bodyH());
      paint(true);
    };

    const onAbort = (): void => {
      finish(buildDraftFeedbackResult(absFile, state.comments));
    };

    const submit = async (): Promise<void> => {
      persist();
      const proposal = buildFinalFeedbackResult(absFile, state.comments);
      if (!opts.signal?.aborted) await opts.onPropose?.(proposal);
      finish(proposal);
    };

    const requestClose = async (): Promise<void> => {
      persist();
      await opts.onClose?.();
      finish(buildDraftFeedbackResult(absFile, state.comments));
    };

    const handleComposeKey = (input: string, key: Key): void => {
      const c = state.compose;
      if (c === null) return;
      if (key.escape) { state = closeCompose(state); return; }
      if (key.return) { state = commitCompose(state); persist(); return; }
      if (key.newline) { const r = textInsert(c.buffer, c.cursor, '\n'); state = { ...state, compose: { ...c, ...r } }; return; }
      if (key.backspace) { const r = textBackspace(c.buffer, c.cursor); state = { ...state, compose: { ...c, ...r } }; return; }
      if (key.del) { const r = textDelete(c.buffer, c.cursor); state = { ...state, compose: { ...c, ...r } }; return; }
      if (key.leftArrow) { state = { ...state, compose: { ...c, cursor: Math.max(0, c.cursor - 1) } }; return; }
      if (key.rightArrow) { state = { ...state, compose: { ...c, cursor: Math.min([...c.buffer].length, c.cursor + 1) } }; return; }
      if (key.home) { state = { ...state, compose: { ...c, cursor: textHome(c.buffer, c.cursor) } }; return; }
      if (key.end) { state = { ...state, compose: { ...c, cursor: textEnd(c.buffer, c.cursor) } }; return; }
      if (key.upArrow) { state = { ...state, compose: { ...c, cursor: textVertical(c.buffer, c.cursor, -1) } }; return; }
      if (key.downArrow) { state = { ...state, compose: { ...c, cursor: textVertical(c.buffer, c.cursor, 1) } }; return; }
      if (input.length === 1 && !key.ctrl) {
        const r = textInsert(c.buffer, c.cursor, input);
        state = { ...state, compose: { ...c, ...r } };
        return;
      }
      if (input.length > 1) {
        const clean = cleanPastedText(input);
        if (clean.length === 0) return;
        const r = textInsert(c.buffer, c.cursor, clean);
        state = { ...state, compose: { ...c, ...r } };
      }
    };

    const handleListKey = (input: string, key: Key): void => {
      if (key.escape || input === 'q') { state = closeList(state); return; }
      if (input === 'j' || key.downArrow) { state = moveListIndex(state, 1); return; }
      if (input === 'k' || key.upArrow) { state = moveListIndex(state, -1); return; }
      if (input === 'e' || key.return) {
        if (state.comments.length > 0) {
          state = openComposeEdit(state, state.listIndex);
          state = ensureAnchorVisible(state, doc, bodyH());
        }
        return;
      }
      if (input === 'd') { if (state.comments.length > 0) { state = deleteAtListIndex(state); persist(); } return; }
    };

    const onData = (data: Buffer): void => {
      if (settled) return;
      const { input, key } = parseKeypress(data);

      if (key.meta && input === 'i') { void requestClose(); return; }

      if (state.mode === 'compose') { handleComposeKey(input, key); paint(); return; }

      if (spaceArmed) {
        spaceArmed = false;
        if (input === 'c') {
          state = openComposeNew(state);
          state = ensureAnchorVisible(state, doc, bodyH());
        } else if (input === 'l') state = openList(state);
        else if (input === 'u') { state = undoLast(state); persist(); }
        else if (input === 's') { void submit(); return; }
        else if (input === 'w') { persist(); finishWith({ type: 'handoff' }); return; }
        paint();
        return;
      }

      if (state.mode === 'list') { handleListKey(input, key); paint(); return; }
      if (state.mode === 'help') { if (input === '?' || key.escape) state = closeHelp(state); paint(); return; }

      // view mode
      if (input === ' ') { spaceArmed = true; return; }
      if (input === 'j' || key.downArrow) { state = moveActiveUnit(state, 1, false); state = ensureAnchorVisible(state, doc, bodyH()); }
      else if (input === 'k' || key.upArrow) { state = moveActiveUnit(state, -1, false); state = ensureAnchorVisible(state, doc, bodyH()); }
      else if (input === 'J') { state = moveActiveUnit(state, 1, true); state = ensureAnchorVisible(state, doc, bodyH()); }
      else if (input === 'K') { state = moveActiveUnit(state, -1, true); state = ensureAnchorVisible(state, doc, bodyH()); }
      else if (input === 'u' || key.pageUp) state = scrollBy(state, -bodyH(), bodyH(), doc.lines.length);
      else if (input === 'd' || key.pageDown) state = scrollBy(state, bodyH(), bodyH(), doc.lines.length);
      else if (input === '?') state = openHelp(state);
      else if (key.escape) { finish(buildDraftFeedbackResult(absFile, state.comments)); return; }
      paint();
    };

    process.stdin.on('data', onData);
    process.stdout.on('resize', onResize);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    paint(true);
  });
}
