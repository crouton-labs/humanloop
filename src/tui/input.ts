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
  if (state.phase === 'final' && state.responses.size >= state.interactions.length) {
    exit();
  }
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
      submitOption(state, interaction, matched.id, undefined);
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
  if (input === 'q') { state.phase = 'overview'; render(); return; }
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

  // Match by shortcut
  const matched = opts.find((o) => o.shortcut === input);
  if (matched !== undefined) {
    submitOption(state, interaction, matched.id, undefined);
    advanceItem(state, 1);
    render();
    return;
  }

  // Comment mode: allowFreetext + options exist
  // If the cursor is on an option row, pre-attach that option to the comment.
  if (input === 'c' && interaction.allowFreetext && opts.length > 0) {
    const preselected = state.selectedAction < opts.length
      ? opts[state.selectedAction]!.id
      : undefined;
    state.inputMode = preselected !== undefined
      ? { kind: 'comment', buffer: '', selectedOptionId: preselected }
      : { kind: 'comment', buffer: '' };
    render();
    return;
  }

  // Freetext-only: 'r' or enter opens input mode
  if (interaction.allowFreetext && opts.length === 0) {
    if (input === 'r' || key.return) {
      const existing = state.responses.get(interaction.id);
      const prefill = existing !== undefined && existing.freetext !== undefined ? existing.freetext : '';
      state.inputMode = { kind: 'freetext', buffer: prefill };
      render();
      return;
    }
  }

  // Enter on selected option row
  if (key.return && state.selectedAction < opts.length) {
    const o = opts[state.selectedAction]!;
    submitOption(state, interaction, o.id, undefined);
    advanceItem(state, 1);
    render();
    return;
  }

  // Enter on the [c] row (allowFreetext + options exist)
  if (key.return && state.selectedAction === opts.length
      && interaction.allowFreetext && opts.length > 0) {
    state.inputMode = { kind: 'comment', buffer: '' };
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
    const attached = mode.kind === 'comment' ? mode.selectedOptionId : undefined;
    submitOption(state, interaction, attached, mode.buffer);
    state.inputMode = null;
    advanceItem(state, 1);
    render();
    return;
  }

  if (key.backspace) {
    const chars = [...mode.buffer];
    chars.pop();
    mode.buffer = chars.join('');
    render();
    return;
  }

  const cleaned = input
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '');
  if (cleaned.length > 0) {
    mode.buffer += cleaned;
    render();
  }
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
  state.persist?.();
}
