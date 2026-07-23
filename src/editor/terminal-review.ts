import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { FeedbackComment, FeedbackResult } from '../types.js';
import type { ReviewOptions } from './review.js';
import { buildDraftFeedbackResult, buildFinalFeedbackResult, readReviewDraft, writeReviewDraft } from './feedback.js';
import { renderMarkdown } from '../render/termrender.js';
import { setupTerminal, restoreTerminal, getTerminalSize, parseKeypress, type Key } from '../tui/terminal.js';
import { diffFrame, renderInputBuffer } from '../tui/render.js';
import { BOLD, CYAN, DIM, RESET, YELLOW, hline, sanitize, truncate } from '../tui/ansi.js';

// ── Pure state ───────────────────────────────────────────────────────────────
// Raw source lines and rendered (termrender) lines are kept strictly separate:
// termrender wraps/adds rows (tables, Mermaid diagrams) so a rendered row never
// maps 1:1 to a source line. Anchors are always resolved against `sourceLines`;
// the rendered pane is a plain scrollable view with no anchor awareness.

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
  comments: FeedbackComment[];
  version: number;
  /** 1-based active source line. */
  activeLine: number;
  /** Set while a Shift+j/k range is being extended from this line. */
  selectionAnchor: number | null;
  /** Scroll offset into the rendered (termrender) lines. */
  scroll: number;
  mode: 'view' | 'list' | 'compose' | 'help';
  compose: ComposeState | null;
  listIndex: number;
}

export function initReviewState(sourceLines: string[], comments: FeedbackComment[], version: number): ReviewState {
  return {
    sourceLines,
    comments: [...comments],
    version,
    activeLine: comments.length > 0 ? comments[0]!.line : 1,
    selectionAnchor: null,
    scroll: 0,
    mode: 'view',
    compose: null,
    listIndex: 0,
  };
}

export function currentAnchor(state: ReviewState): { line: number; endLine: number } {
  if (state.selectionAnchor === null) return { line: state.activeLine, endLine: state.activeLine };
  return { line: Math.min(state.selectionAnchor, state.activeLine), endLine: Math.max(state.selectionAnchor, state.activeLine) };
}

export function moveActiveLine(state: ReviewState, delta: number, extend: boolean): ReviewState {
  const total = Math.max(1, state.sourceLines.length);
  const next = Math.max(1, Math.min(total, state.activeLine + delta));
  if (!extend) return { ...state, activeLine: next, selectionAnchor: null };
  return { ...state, activeLine: next, selectionAnchor: state.selectionAnchor ?? state.activeLine };
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
  return {
    ...state,
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

/** Reserved (non-body) rows for each mode's fixed header/footer chrome. Kept in
 *  sync with renderReviewFrame so scroll math can clamp before a repaint. */
export function reservedRows(state: ReviewState): number {
  const header = 3; // blank, title, divider
  if (state.mode === 'view') return header + 2;
  if (state.mode === 'compose') {
    const c = state.compose;
    const bufLines = c ? Math.max(1, c.buffer.split('\n').length) : 1;
    return header + 3 + bufLines;
  }
  if (state.mode === 'list') return header + Math.max(1, state.comments.length) + 2;
  return header + 8; // help
}

export function renderReviewFrame(state: ReviewState, fileLabel: string, renderedLines: string[], cols: number, rows: number): string[] {
  const maxW = Math.min(Math.max(20, cols - 4), 120);
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
    footer.push(`  ${DIM}j/k${RESET}         move anchor line       ${DIM}shift+j/k${RESET}   extend range`);
    footer.push(`  ${DIM}u/d, pgup/pgdn${RESET}  scroll document`);
    footer.push(`  ${DIM}space c${RESET}     compose comment        ${DIM}space l${RESET}     list comments`);
    footer.push(`  ${DIM}space u${RESET}     undo last comment      ${DIM}space s${RESET}     submit review`);
    footer.push(`  ${DIM}?${RESET}           toggle this help       ${DIM}esc${RESET}         close/cancel`);
    footer.push('');
    footer.push(`  ${DIM}esc / ?${RESET} close`);
  } else {
    const anchor = currentAnchor(state);
    const label = anchor.line === anchor.endLine ? `L${anchor.line}` : `L${anchor.line}-${anchor.endLine}`;
    const preview = truncate(sanitize(state.sourceLines.slice(anchor.line - 1, anchor.endLine).join(' / ')), Math.max(10, maxW - 20));
    footer.push(`  ${DIM}Anchor:${RESET} ${CYAN}${label}${RESET}  ${DIM}${preview}${RESET}`);
    footer.push(
      `  ${DIM}j/k${RESET} anchor  ${DIM}shift-j/k${RESET} range  ${DIM}u/d${RESET} scroll  ${DIM}space c${RESET} comment  ` +
      `${DIM}space l${RESET} list  ${DIM}space u${RESET} undo  ${DIM}space s${RESET} submit  ${DIM}?${RESET} help  ${DIM}esc${RESET} close`,
    );
  }

  const reserved = header.length + footer.length;
  const bodyHeight = Math.max(1, rows - reserved);
  const maxScroll = Math.max(0, renderedLines.length - bodyHeight);
  const scroll = Math.max(0, Math.min(state.scroll, maxScroll));
  const body = renderedLines.slice(scroll, scroll + bodyHeight).map((l) => `  ${l}`);
  if (scroll > 0 && body.length > 0) body[0] = `  ${DIM}↑ ${scroll} more above${RESET}`;
  const remaining = renderedLines.length - (scroll + bodyHeight);
  if (remaining > 0 && body.length > 0) body[body.length - 1] = `  ${DIM}↓ ${remaining} more below${RESET}`;
  while (body.length < bodyHeight) body.push('');

  const lines = [...header, ...body, ...footer];
  while (lines.length < rows) lines.push('');
  return lines.slice(0, rows);
}

// ── Host loop (impure — the only part that touches the real TTY) ───────────

/**
 * Open a Markdown file in humanloop's own terminal review surface: the
 * document renders via termrender (Mermaid included), source-line anchors
 * drive comments independent of rendered scroll position, and the human
 * explicitly submits a proposal. Never edits the source file. Autosaves the
 * comment draft to `opts.output` (the `progress.json` convention). Canonical
 * ticket finalization stays with the caller's `onPropose` (the adapter calls
 * `completeReview`); this function never writes `response.json`.
 */
export async function launchTerminalReview(file: string, opts: ReviewOptions): Promise<FeedbackResult> {
  const absFile = resolve(file);
  const content = readFileSync(absFile, 'utf8');
  const sourceLines = content.split('\n');
  const outPath = resolve(opts.output);
  const draft = readReviewDraft(outPath);
  let state = initReviewState(sourceLines, draft?.comments ?? [], draft?.version ?? 0);
  const fileLabel = basename(absFile);

  if (opts.signal?.aborted) return buildDraftFeedbackResult(absFile, state.comments, draft?.savedAt);

  setupTerminal();
  let { cols, rows } = getTerminalSize();
  let renderedWidth = Math.min(Math.max(20, cols - 4), 120);
  let renderedLines = renderMarkdown(content, renderedWidth);
  let prevFrame: string[] = [];
  let spaceArmed = false;
  let settled = false;

  return new Promise<FeedbackResult>((resolvePromise) => {
    const persist = (): void => {
      state = { ...state, version: state.version + 1 };
      writeReviewDraft(outPath, state.comments, state.version);
    };

    const paint = (clear = false): void => {
      const lines = renderReviewFrame(state, fileLabel, renderedLines, cols, rows);
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

    const finish = (result: FeedbackResult): void => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', onResize);
      opts.signal?.removeEventListener('abort', onAbort);
      restoreTerminal();
      resolvePromise(result);
    };

    const onResize = (): void => {
      ({ cols, rows } = getTerminalSize());
      renderedWidth = Math.min(Math.max(20, cols - 4), 120);
      renderedLines = renderMarkdown(content, renderedWidth);
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
      if (input === 'e' || key.return) { if (state.comments.length > 0) state = openComposeEdit(state, state.listIndex); return; }
      if (input === 'd') { if (state.comments.length > 0) { state = deleteAtListIndex(state); persist(); } return; }
    };

    const onData = (data: Buffer): void => {
      if (settled) return;
      const { input, key } = parseKeypress(data);

      if (key.meta && input === 'i') { void requestClose(); return; }

      if (state.mode === 'compose') { handleComposeKey(input, key); paint(); return; }

      if (spaceArmed) {
        spaceArmed = false;
        if (input === 'c') state = openComposeNew(state);
        else if (input === 'l') state = openList(state);
        else if (input === 'u') { state = undoLast(state); persist(); }
        else if (input === 's') { void submit(); return; }
        paint();
        return;
      }

      if (state.mode === 'list') { handleListKey(input, key); paint(); return; }
      if (state.mode === 'help') { if (input === '?' || key.escape) state = closeHelp(state); paint(); return; }

      // view mode
      if (input === ' ') { spaceArmed = true; return; }
      if (input === 'j' || key.downArrow) state = moveActiveLine(state, 1, false);
      else if (input === 'k' || key.upArrow) state = moveActiveLine(state, -1, false);
      else if (input === 'J') state = moveActiveLine(state, 1, true);
      else if (input === 'K') state = moveActiveLine(state, -1, true);
      else if (input === 'u' || key.pageUp) state = scrollBy(state, -Math.max(1, rows - reservedRows(state)), Math.max(1, rows - reservedRows(state)), renderedLines.length);
      else if (input === 'd' || key.pageDown) state = scrollBy(state, Math.max(1, rows - reservedRows(state)), Math.max(1, rows - reservedRows(state)), renderedLines.length);
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
