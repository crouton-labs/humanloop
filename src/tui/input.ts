import type { TuiState, Interaction, InteractionResponse } from '../types.js';
import type { Key } from './terminal.js';

export type RenderFn = () => void;
export type ExitFn = () => void;

const RESERVED = new Set(['c', 'r', 'n', 'p', 'q', 'j', 'k', 'u', 'd', ' ']);

export function assignShortcuts(interactions: Interaction[]): void {
  for (const it of interactions) {
    const used = new Set<string>(
      it.options.map((o) => o.shortcut).filter((s): s is string => s !== undefined),
    );
    for (const opt of it.options) {
      if (opt.shortcut !== undefined) continue;
      const letters = [...opt.label.toLowerCase()].filter((c) => /[a-z]/.test(c));
      let chosen: string | undefined;
      for (const letter of letters) {
        if (!used.has(letter) && !RESERVED.has(letter)) { chosen = letter; break; }
      }
      if (chosen === undefined) {
        for (let d = 1; d <= 9; d++) {
          const s = String(d);
          if (!used.has(s)) { chosen = s; break; }
        }
      }
      if (chosen !== undefined) { opt.shortcut = chosen; used.add(chosen); }
    }
  }
}

export function handleKeypress(
  input: string,
  key: Key,
  state: TuiState,
  render: RenderFn,
  exit: ExitFn,
): void {
  if (key.ctrl && input === 'c') {
    exit();
    return;
  }

  // Clear any transient hint from the previous keypress. Handlers below may set
  // a fresh one (e.g. an empty multi-select Enter), so it survives exactly one
  // render cycle.
  state.hint = undefined;

  if (state.inputMode) {
    handleInputMode(input, key, state, render);
    checkAutoExit(state, exit);
    return;
  }

  switch (state.phase) {
    case 'overview':
      handleOverview(input, key, state, render, exit);
      break;
    case 'item-review':
      handleItemReview(input, key, state, render);
      checkAutoExit(state, exit);
      break;
    case 'final':
      handleFinal(input, key, state, render, exit);
      break;
  }
}

function checkAutoExit(state: TuiState, exit: ExitFn): void {
  if (state.phase !== 'final') return;
  if (state.responses.size < state.interactions.length) return;
  // Multi-select commits route THROUGH the Summary/confirm screen instead of
  // auto-exiting on the first Enter: the commit advances the deck to `final`,
  // but the human must press Enter again (handleFinal) to actually submit.
  // The interaction that pushed us into `final` is still at currentIndex — the
  // advance helpers leave it there when they fall through to `final` — so a
  // multi-select there means "just confirmed a set, await deliberate submit".
  // Single-select keeps its submit-on-pick fast path (auto-exit below).
  const justCommitted = state.interactions[state.currentIndex];
  if (justCommitted?.multiSelect === true) return;
  exit();
}

// ── Overview ─────────────────────────────────────────────────────────────────

function handleOverview(
  input: string,
  key: Key,
  state: TuiState,
  render: RenderFn,
  exit: ExitFn,
): void {
  if (input === 'j' || key.downArrow) {
    state.currentIndex = Math.min(state.currentIndex + 1, state.interactions.length - 1);
    render();
    return;
  }
  if (input === 'k' || key.upArrow) {
    state.currentIndex = Math.max(state.currentIndex - 1, 0);
    render();
    return;
  }
  if (key.return || input === ' ') {
    state.phase = 'item-review';
    state.selectedAction = 0;
    state.detailExpanded = false;
    render();
    return;
  }
  if (input === 'q') {
    if (state.responses.size >= state.interactions.length) {
      exit();
    } else {
      state.phase = 'final';
      render();
    }
    return;
  }

  // Quick-answer: option shortcut for the focused interaction. Lets users
  // answer from the overview list without pressing Enter first.
  const interaction = state.interactions[state.currentIndex];
  if (interaction !== undefined) {
    const matched = interaction.options.find((o) => o.shortcut === input);
    if (matched !== undefined) {
      if (interaction.multiSelect) {
        toggleMulti(state, interaction, matched.id);
      } else {
        submitOption(state, interaction, matched.id, undefined);
      }
      // Don't auto-advance the cursor — users may want to re-answer the same
      // question. The response icon flips ✓ and they can j/k away when ready.
      render();
    }
  }
}

// ── Item Review ──────────────────────────────────────────────────────────────

function handleItemReview(
  input: string,
  key: Key,
  state: TuiState,
  render: RenderFn,
): void {
  const interaction = state.interactions[state.currentIndex]!;

  if (input === 'n') { advanceItem(state, 1); render(); return; }
  if (input === 'p') { advanceItem(state, -1); render(); return; }
  // q / Esc step back to the deck overview (one level up from a card).
  if (input === 'q' || key.escape) { state.phase = 'overview'; render(); return; }
  // Space toggles the focused option for multi-select; otherwise expand context.
  if (input === ' ' && interaction.multiSelect
      && state.selectedAction < interaction.options.length) {
    toggleMulti(state, interaction, interaction.options[state.selectedAction]!.id);
    render();
    return;
  }
  if (input === ' ') { state.detailExpanded = !state.detailExpanded; render(); return; }

  // Body scroll: u/d or Ctrl+D / Ctrl+U (half-page), Ctrl+E / Ctrl+Y (line).
  // Plain u/d exists because tmux configs commonly bind C-d/C-u for pane scroll
  // and intercept them before they reach the app. Render clamps state.scrollOffset,
  // so over-scroll past the bottom is harmless.
  if (input === 'd' || (key.ctrl && (input === 'd' || input === 'e'))) {
    state.scrollOffset = (state.scrollOffset ?? 0) + (input === 'e' ? 1 : 10);
    render();
    return;
  }
  if (input === 'u' || (key.ctrl && (input === 'u' || input === 'y'))) {
    state.scrollOffset = Math.max(0, (state.scrollOffset ?? 0) - (input === 'y' ? 1 : 10));
    render();
    return;
  }

  if (input === 'j' || key.downArrow) {
    const max = actionCount(interaction) - 1;
    state.selectedAction = Math.min(state.selectedAction + 1, max);
    render();
    return;
  }
  if (input === 'k' || key.upArrow) {
    state.selectedAction = Math.max(state.selectedAction - 1, 0);
    render();
    return;
  }

  handleInteractionAction(input, key, state, interaction, render);
}

function handleInteractionAction(
  input: string,
  key: Key,
  state: TuiState,
  interaction: Interaction,
  render: RenderFn,
): void {
  const opts = interaction.options;

  // Match by shortcut. Multi-select toggles (stay put); single-select submits.
  const matched = opts.find((o) => o.shortcut === input);
  if (matched !== undefined) {
    if (interaction.multiSelect) {
      toggleMulti(state, interaction, matched.id);
      render();
      return;
    }
    submitOption(state, interaction, matched.id, undefined);
    advanceToNextUnanswered(state);
    render();
    return;
  }

  // Comment mode: allowFreetext + options exist.
  //
  // Single-select: pre-attach the focused option (the comment qualifies that
  // pick). Multi-select: also pre-attach the focused option — the comment is
  // saved under `optionComments[id]` (per-option note) and submitting
  // auto-checks the option. From the [c] freetext row in multi-select,
  // start with no attachment so the comment becomes the overall freetext.
  if (input === 'c' && interaction.allowFreetext && opts.length > 0) {
    const onOption = state.selectedAction < opts.length;
    if (onOption) {
      const optId = opts[state.selectedAction]!.id;
      let prefill = '';
      if (interaction.multiSelect) {
        const existing = state.responses.get(interaction.id);
        const prior = existing?.optionComments?.[optId];
        if (typeof prior === 'string') prefill = prior;
      }
      state.inputMode = { kind: 'comment', buffer: prefill, cursor: [...prefill].length, selectedOptionId: optId };
    } else {
      // On the [c] row in multi-select: pre-fill from existing overall freetext.
      let prefill = '';
      if (interaction.multiSelect) {
        const existing = state.responses.get(interaction.id);
        if (existing !== undefined && typeof existing.freetext === 'string') {
          prefill = existing.freetext;
        }
      }
      state.inputMode = { kind: 'comment', buffer: prefill, cursor: [...prefill].length };
    }
    render();
    return;
  }

  // Freetext-only: 'r' or enter opens input mode
  if (interaction.allowFreetext && opts.length === 0) {
    if (input === 'r' || key.return) {
      const existing = state.responses.get(interaction.id);
      const prefill = existing !== undefined && existing.freetext !== undefined ? existing.freetext : '';
      state.inputMode = { kind: 'freetext', buffer: prefill, cursor: [...prefill].length };
      render();
      return;
    }
  }

  // Enter on selected option row. Multi-select confirms the accumulated set
  // and advances; single-select picks that one option.
  if (key.return && state.selectedAction < opts.length) {
    if (interaction.multiSelect) {
      const checked = state.responses.get(interaction.id)?.selectedOptionIds ?? [];
      if (checked.length === 0) {
        // Accidental Enter with nothing toggled is a no-op: don't finalize or
        // advance. A deliberate empty finish is still reachable via `q` →
        // overview → finish (partial); freetext-only via the [c] row.
        state.hint = 'Select at least one option (space to toggle), or q to skip';
        render();
        return;
      }
      commitMulti(state, interaction);
      advanceToNextUnanswered(state);
      render();
      return;
    }
    const o = opts[state.selectedAction]!;
    submitOption(state, interaction, o.id, undefined);
    advanceToNextUnanswered(state);
    render();
    return;
  }

  // Enter on the [c] row (allowFreetext + options exist)
  if (key.return && state.selectedAction === opts.length
      && interaction.allowFreetext && opts.length > 0) {
    state.inputMode = { kind: 'comment', buffer: '', cursor: 0 };
    render();
    return;
  }
}

// ── Input Mode ───────────────────────────────────────────────────────────────

function handleInputMode(
  input: string,
  key: Key,
  state: TuiState,
  render: RenderFn,
): void {
  const mode = state.inputMode!;

  if (key.escape) {
    state.inputMode = null;
    render();
    return;
  }

  // Tab cycles attached option in comment mode: (none) → opt1 → opt2 → ... → (none)
  if (key.tab && mode.kind === 'comment') {
    const interaction = state.interactions[state.currentIndex]!;
    const opts = interaction.options;
    if (opts.length > 0) {
      const cur = mode.selectedOptionId;
      const curIdx = cur === undefined ? -1 : opts.findIndex((o) => o.id === cur);
      const nextIdx = curIdx + 1; // -1 → 0, last → length (which we map to none)
      if (nextIdx >= opts.length) {
        delete mode.selectedOptionId;
      } else {
        mode.selectedOptionId = opts[nextIdx]!.id;
      }
      render();
    }
    return;
  }

  if (key.return) {
    const interaction = state.interactions[state.currentIndex]!;
    const perOption = interaction.multiSelect === true
      && mode.kind === 'comment'
      && mode.selectedOptionId !== undefined;
    if (perOption) {
      // Per-option comment: save under optionComments[id], auto-check the
      // option (idempotent), stay on this interaction so the human can comment
      // on another option.
      setOptionComment(state, interaction, mode.selectedOptionId as string, mode.buffer);
      state.inputMode = null;
      render();
      return;
    }
    if (interaction.multiSelect) {
      commitMulti(state, interaction, mode.buffer);
    } else {
      const attached = mode.kind === 'comment' ? mode.selectedOptionId : undefined;
      submitOption(state, interaction, attached, mode.buffer);
    }
    state.inputMode = null;
    advanceToNextUnanswered(state);
    render();
    return;
  }

  // Newline-insert chord (ctrl+j / alt+enter) — distinct from key.return
  // (submit), handled above.
  if (key.newline) {
    insertAtCursor(mode, '\n');
    render();
    return;
  }

  // ── Cursor motion ──────────────────────────────────────────────────────
  if (key.leftArrow) {
    mode.cursor = Math.max(0, mode.cursor - 1);
    render();
    return;
  }
  if (key.rightArrow) {
    mode.cursor = Math.min([...mode.buffer].length, mode.cursor + 1);
    render();
    return;
  }
  if (key.wordLeft) {
    mode.cursor = wordLeftIndex(mode.buffer, mode.cursor);
    render();
    return;
  }
  if (key.wordRight) {
    mode.cursor = wordRightIndex(mode.buffer, mode.cursor);
    render();
    return;
  }
  if (key.home || (key.ctrl && input === 'a')) {
    mode.cursor = lineStart(mode.buffer, mode.cursor);
    render();
    return;
  }
  if (key.end || (key.ctrl && input === 'e')) {
    mode.cursor = lineEnd(mode.buffer, mode.cursor);
    render();
    return;
  }

  // ── Edits ───────────────────────────────────────────────────────────────
  if (key.backspace && key.meta) {
    deleteWordAtCursor(mode);
    render();
    return;
  }

  // Ctrl-U: delete from line start to cursor (readline "unix-line-discard").
  // iTerm2 maps Cmd+Backspace to a bare 0x15, which arrives here as ctrl+'u'.
  if (key.ctrl && input === 'u') {
    deleteToLineStart(mode);
    render();
    return;
  }

  if (key.del) {
    deleteAtCursor(mode);
    render();
    return;
  }

  if (key.backspace) {
    backspaceAtCursor(mode);
    render();
    return;
  }

  // Typed input / paste. Bracketed-paste markers and other control chars are
  // stripped, but \n (0x0A) is preserved so pasted newlines land as real
  // newlines in the buffer instead of vanishing (CRLF is normalized to LF).
  const cleaned = input
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
  if (cleaned.length > 0) {
    insertAtCursor(mode, cleaned);
    render();
  }
}

// ── Cursor-aware editing helpers ────────────────────────────────────────────
// Operate on code-point arrays (not UTF-16 code units) so multi-byte chars
// (emoji, combining marks) move/delete as one unit under the cursor.

interface EditableInput {
  buffer: string;
  cursor: number;
}

function insertAtCursor(mode: EditableInput, text: string): void {
  const chars = [...mode.buffer];
  const insert = [...text];
  chars.splice(mode.cursor, 0, ...insert);
  mode.buffer = chars.join('');
  mode.cursor += insert.length;
}

function backspaceAtCursor(mode: EditableInput): void {
  if (mode.cursor <= 0) return;
  const chars = [...mode.buffer];
  chars.splice(mode.cursor - 1, 1);
  mode.buffer = chars.join('');
  mode.cursor -= 1;
}

function deleteAtCursor(mode: EditableInput): void {
  const chars = [...mode.buffer];
  if (mode.cursor >= chars.length) return;
  chars.splice(mode.cursor, 1);
  mode.buffer = chars.join('');
}

function deleteWordAtCursor(mode: EditableInput): void {
  const start = wordLeftIndex(mode.buffer, mode.cursor);
  const chars = [...mode.buffer];
  chars.splice(start, mode.cursor - start);
  mode.buffer = chars.join('');
  mode.cursor = start;
}

function deleteToLineStart(mode: EditableInput): void {
  const start = lineStart(mode.buffer, mode.cursor);
  const chars = [...mode.buffer];
  chars.splice(start, mode.cursor - start);
  mode.buffer = chars.join('');
  mode.cursor = start;
}

/** Skip whitespace backward from `cursor`, then skip the non-whitespace word
 *  before it — lands on the word's start (readline alt-b / ctrl+left). */
function wordLeftIndex(buffer: string, cursor: number): number {
  const chars = [...buffer];
  let i = Math.min(cursor, chars.length);
  while (i > 0 && /\s/.test(chars[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(chars[i - 1]!)) i--;
  return i;
}

/** Skip whitespace forward from `cursor`, then skip the non-whitespace word
 *  after it — lands just past the word's end (readline alt-f / ctrl+right). */
function wordRightIndex(buffer: string, cursor: number): number {
  const chars = [...buffer];
  let i = Math.min(cursor, chars.length);
  while (i < chars.length && /\s/.test(chars[i]!)) i++;
  while (i < chars.length && !/\s/.test(chars[i]!)) i++;
  return i;
}

/** Index just after the previous `\n` (or 0), i.e. the start of the current
 *  visual line — the multiline analog of ctrl+a/home. */
function lineStart(buffer: string, cursor: number): number {
  const chars = [...buffer];
  let i = Math.min(cursor, chars.length);
  while (i > 0 && chars[i - 1] !== '\n') i--;
  return i;
}

/** Index at the next `\n` (or end of buffer) — the multiline analog of
 *  ctrl+e/end. */
function lineEnd(buffer: string, cursor: number): number {
  const chars = [...buffer];
  let i = Math.min(cursor, chars.length);
  while (i < chars.length && chars[i] !== '\n') i++;
  return i;
}

// ── Final ────────────────────────────────────────────────────────────────────

function handleFinal(
  input: string,
  key: Key,
  state: TuiState,
  render: RenderFn,
  exit: ExitFn,
): void {
  if (key.return) {
    exit();
  } else if (key.escape) {
    state.phase = 'overview';
    render();
  } else if (input === 'p') {
    state.phase = 'item-review';
    state.currentIndex = state.interactions.length - 1;
    render();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function advanceItem(state: TuiState, direction: number): void {
  const next = state.currentIndex + direction;
  if (next < 0) return;
  if (next >= state.interactions.length) {
    state.phase = 'final';
    return;
  }
  state.currentIndex = next;
  state.selectedAction = 0;
  state.detailExpanded = false;
  state.scrollOffset = 0;
}

/**
 * Move to the next interaction WITHOUT a response, falling through to the
 * final phase if every following interaction is already answered (whether
 * user-answered or `preAnswered`-seeded). Used by all post-submit advance
 * sites so the human flies through pre-approved items by hitting Enter; raw
 * `n`/`p` still step one at a time via `advanceItem`.
 */
function advanceToNextUnanswered(state: TuiState): void {
  let next = state.currentIndex + 1;
  while (next < state.interactions.length && state.responses.has(state.interactions[next]!.id)) {
    next++;
  }
  if (next >= state.interactions.length) {
    state.phase = 'final';
    return;
  }
  state.currentIndex = next;
  state.selectedAction = 0;
  state.detailExpanded = false;
  state.scrollOffset = 0;
}

function actionCount(interaction: Interaction): number {
  return interaction.options.length + (interaction.allowFreetext && interaction.options.length > 0 ? 1 : 0);
}

function submitOption(
  state: TuiState,
  interaction: Interaction,
  selectedOptionId: string | undefined,
  freetext: string | undefined,
): void {
  const response: InteractionResponse = { id: interaction.id };
  if (selectedOptionId !== undefined) response.selectedOptionId = selectedOptionId;
  if (freetext !== undefined) response.freetext = freetext;
  state.responses.set(interaction.id, response);
  // Explicit user submission overrides any preAnswered seed — flip the icon
  // from "previously answered" to user-answered.
  state.preAnsweredIds.delete(interaction.id);
  state.persist?.();
}

// ── Multi-select ─────────────────────────────────────────────────────────────
// Toggle/commit write progressively into state.responses (mirrors single-select
// submitOption immediacy); Enter just confirms the accumulated set + advances.

function toggleMulti(state: TuiState, interaction: Interaction, optionId: string): void {
  const existing = state.responses.get(interaction.id);
  const priorIds = existing !== undefined && existing.selectedOptionIds !== undefined
    ? existing.selectedOptionIds
    : [];
  const set = new Set(priorIds);
  if (set.has(optionId)) set.delete(optionId);
  else set.add(optionId);
  const response: InteractionResponse = { id: interaction.id, selectedOptionIds: [...set] };
  if (existing !== undefined && existing.freetext !== undefined) response.freetext = existing.freetext;
  if (existing !== undefined && existing.optionComments !== undefined) {
    response.optionComments = { ...existing.optionComments };
  }
  state.responses.set(interaction.id, response);
  // User edited the checked set — no longer a passive carry-over.
  state.preAnsweredIds.delete(interaction.id);
  state.persist?.();
}

/** Ensure a (possibly empty) response exists so the interaction counts as
 *  answered, optionally setting/replacing freetext. */
function commitMulti(
  state: TuiState,
  interaction: Interaction,
  freetext?: string,
): void {
  const existing = state.responses.get(interaction.id);
  const priorIds = existing !== undefined && existing.selectedOptionIds !== undefined
    ? existing.selectedOptionIds
    : [];
  const response: InteractionResponse = {
    id: interaction.id,
    selectedOptionIds: [...priorIds],
  };
  let ft: string | undefined;
  if (freetext !== undefined) ft = freetext;
  else if (existing !== undefined) ft = existing.freetext;
  if (ft !== undefined) response.freetext = ft;
  if (existing !== undefined && existing.optionComments !== undefined) {
    response.optionComments = { ...existing.optionComments };
  }
  state.responses.set(interaction.id, response);
  // Explicit confirm overrides any preAnswered seed.
  state.preAnsweredIds.delete(interaction.id);
  state.persist?.();
}

/**
 * Multi-select per-option comment: write `comment` to optionComments[optionId]
 * and auto-check the option. Empty comment still records the entry (the user
 * committed deliberately via Enter; Esc cancels without write).
 */
function setOptionComment(
  state: TuiState,
  interaction: Interaction,
  optionId: string,
  comment: string,
): void {
  const existing = state.responses.get(interaction.id);
  const priorIds = existing !== undefined && existing.selectedOptionIds !== undefined
    ? existing.selectedOptionIds
    : [];
  const set = new Set(priorIds);
  set.add(optionId);
  const priorComments = existing !== undefined && existing.optionComments !== undefined
    ? existing.optionComments
    : {};
  const nextComments: Record<string, string> = { ...priorComments, [optionId]: comment };
  const response: InteractionResponse = {
    id: interaction.id,
    selectedOptionIds: [...set],
    optionComments: nextComments,
  };
  if (existing !== undefined && existing.freetext !== undefined) response.freetext = existing.freetext;
  state.responses.set(interaction.id, response);
  state.preAnsweredIds.delete(interaction.id);
  state.persist?.();
}
